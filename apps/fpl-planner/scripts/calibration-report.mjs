#!/usr/bin/env node
// CALIBRATION OF THE PROJECTIONS, deadline by deadline, in the production regime.
//
// WHY THIS EXISTS
//
// Planner points are what decide an experiment (experiments/registry.md), but
// points cannot tell you that every nailed starter is projected to play 70% of
// the time, or that the best player in the league projects 3.9. The xP audit of
// 2026-09-16 found exactly that in production while every test was green,
// because nothing compared a projection with what then happened at the level a
// manager reads it: this player, this gameweek.
//
// This script replays each season's deadlines through the SAME resolution the
// app runs (`productionGameStateAt`: the payloads production would have read,
// the shipped previous-season asset, engine/world.js), projects every player
// for that gameweek, and scores the projections against the gameweek's actual
// rows. Nothing is fitted here and nothing is tuned against it; it is the
// instrument that says whether the projections describe football.
//
// Usage:
//   node apps/fpl-planner/scripts/calibration-report.mjs
//   node apps/fpl-planner/scripts/calibration-report.mjs --seasons 2024-25,2025-26 --gw 1-12
//   node apps/fpl-planner/scripts/calibration-report.mjs --json out.json
//   node apps/fpl-planner/scripts/calibration-report.mjs --check
//   node apps/fpl-planner/scripts/calibration-report.mjs --model-options '{"someKnob":1}'
//   node apps/fpl-planner/scripts/calibration-report.mjs --no-reference
//
// REFERENCE BASELINES (printed after the calibration sections, on by default,
// `--no-reference` drops them). The same rows the engine is scored on are also
// predicted by three naive rules that read only gameweeks before the deadline:
// points per club match (season-to-date points over the club fixtures the
// player was registered for, falling back to last season's per-match rate at
// gameweek 1 or for a player with no rows yet), season points per appearance,
// and the last five appearances' points per appearance. Each is scored with
// bias, MAE, RMSE, MAE and bias over rows with 60+ minutes, Spearman per
// gameweek, the mean actual points of the top 20 by prediction, and captain
// points (the top prediction, and the top prediction among players priced
// 7.0m+), overall, per season, per bucket, per position and per segment (new
// signings, returning players, low-minutes players, regulars, double-gameweek
// rows), followed by per-deadline paired differences of the engine against
// each baseline with standard errors and win/loss/tie counts. Promoted from
// the 2026-10-09 backend audit's probe: points per club match is the strongest
// naive rule, and an engine that does not beat it on a ranking question has
// nothing to show there.
//
// --model-options <json> is handed to buildStrength and buildProjections as an
// extra `modelOptions` property, so a projection-model candidate can be scored
// here without editing the script. The engine ignores options it does not read.
// `{"odds": ...}` also attaches each deadline's bookmaker prices to the
// GameState the way the replay does (needs the season's odds file).
//
// --check applies the calibration bands (scripts/lib/calibration-guard.mjs, the
// same bands tests/xp-calibration-guard.test.mjs holds the captured 2026/27
// deadlines to) to every season's gameweek buckets separately, prints each band
// a bucket breaks, and exits 1 if any bucket from gameweek 2 on does. It is the
// archive-wide form of the hermetic test: run it after any change to the
// minutes, rates, strength or resolution code.
//
// Gameweek 1 is printed and never gated. It is one deadline, and the archive
// carries no injury or availability flags, which is what separates the bottom
// of a pre-season pool in production: in the replay the bottom fifth projects
// about 0.43 points above what it scores under the shipped model and the
// repaired one alike.
//
// Seasons without a downloaded predecessor are skipped: production always has
// one (the shipped opening baseline), so a replay without it is not production.
//
// Gameweeks with no fixtures (2022-23 gameweek 7, the round postponed after the
// Queen's death) are not deadlines anything can be scored on and are skipped:
// scored, they read as a deadline that projected 0 players.
//
// A bucket whose deadlines saw NO expected-goals data at all is printed and not
// gated. That is 2022-23 up to gameweek 16: the archive's expected_* columns
// start at its gameweek 16 and its predecessor, 2021-22, has none, so every
// xG-based rate and the strength model fall back to their priors and the
// league projects flat. That is a fact about the archive, not a calibration
// defect a change could repair, and a gate on it would fail every run.

import fs from 'node:fs';
import { loadSeason, loadRules, previousSeason, KNOWN_SEASONS } from './backtest.mjs';
import {
  createAccumulator, productionGameStateAt, priorSeasonAsset, preseasonTotalsFor, eventDeadlines,
} from '../js/engine/backtest.js';
import { buildStrength } from '../js/engine/strength.js';
import { buildProjections } from '../js/engine/projections.js';
import { matchesKickedOffByClub } from '../js/engine/lifecycle.js';
import { bestEleven, calibrationFacts, calibrationViolations } from './lib/calibration-guard.mjs';

const POSITION = { 1: 'GK', 2: 'DEF', 3: 'MID', 4: 'FWD' };
const BUCKETS = [[1, 1], [2, 3], [4, 8], [9, 19], [20, 38]];

function parseArgs(argv) {
  const out = { seasons: null, gwFrom: 1, gwTo: 38, json: null, check: false, modelOptions: null, reference: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--seasons') out.seasons = argv[++i].split(',');
    else if (a === '--gw') {
      const [from, to] = argv[++i].split('-').map(Number);
      out.gwFrom = from;
      out.gwTo = to || from;
    } else if (a === '--json') out.json = argv[++i];
    else if (a === '--check') out.check = true;
    else if (a === '--model-options') out.modelOptions = JSON.parse(argv[++i]);
    else if (a === '--no-reference') out.reference = false;
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const quantile = (sorted, q) => sorted[Math.floor(q * (sorted.length - 1))];

const COMPONENTS = ['appearance', 'goals', 'assists', 'cleanSheets', 'conceded', 'saves', 'penaltySaves', 'defcon', 'bonus', 'cards'];

// The points a player actually scored in one archive row, split into the same
// components the projection reports, from the rules the season was scored
// under. Penalty misses and own goals are not projected and land in `other`.
function actualComponents(row, position, rules) {
  const pts = (key) => {
    const v = rules.scoring[key];
    if (v === undefined || v === null) return 0;
    return typeof v === 'number' ? v : (typeof v[position] === 'number' ? v[position] : 0);
  };
  const out = Object.fromEntries(COMPONENTS.map(k => [k, 0]));
  if (row.minutes > 0) out.appearance = row.minutes >= 60 ? pts('long_play') : pts('short_play');
  out.goals = row.goalsScored * pts('goals_scored');
  out.assists = row.assists * pts('assists');
  out.cleanSheets = row.cleanSheets * pts('clean_sheets');
  out.conceded = Math.floor(row.goalsConceded / 2) * pts('goals_conceded');
  out.saves = Math.floor(row.saves / 3) * pts('saves');
  out.penaltySaves = row.penaltiesSaved * pts('penalties_saved');
  const threshold = rules.defConThresholds ? rules.defConThresholds[position] : undefined;
  const actions = position === 2 ? (row.cbit || 0) + (row.tackles || 0)
    : position === 3 || position === 4 ? (row.cbit || 0) + (row.recoveries || 0) + (row.tackles || 0) : 0;
  out.defcon = threshold && actions >= threshold ? pts('defensive_contribution') : 0;
  out.bonus = row.bonus * pts('bonus');
  out.cards = row.yellowCards * pts('yellow_cards') + row.redCards * pts('red_cards');
  out.other = row.penaltiesMissed * pts('penalties_missed') + row.ownGoals * pts('own_goals');
  return out;
}

// Spearman's rank correlation with tied values given their average rank, which
// matters here: most players score exactly 1 or 2 in a gameweek.
export function rankCorrelation(x, y) {
  const rank = (v) => {
    const idx = v.map((val, i) => [val, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(v.length);
    for (let j = 0; j < idx.length;) {
      let e = j;
      while (e + 1 < idx.length && idx[e + 1][0] === idx[j][0]) e++;
      for (let t = j; t <= e; t++) r[idx[t][1]] = (j + e) / 2;
      j = e + 1;
    }
    return r;
  };
  if (x.length < 3) return NaN;
  const rx = rank(x);
  const ry = rank(y);
  const mx = mean(rx);
  const my = mean(ry);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < x.length; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : NaN;
}

// One row per player with a fixture this gameweek: what was projected and what
// happened. Actual points and minutes sum a double gameweek, as FPL scores it.
export function scoreDeadline({ dataset, gw, gameState, projections, rankable = null }) {
  const clubMatches = matchesKickedOffByClub(gameState);
  const actualByPlayer = dataset.byGw.get(gw) || new Map();
  const rows = [];
  for (const [id, list] of projections.byPlayer) {
    const r = list[0];
    if (!r || !r.fixtures || !r.fixtures.length) continue;
    const player = gameState.players.get(id);
    const actual = actualByPlayer.get(id) || [];
    const m = clubMatches.get(player.teamId) || 0;
    const components = Object.fromEntries([...COMPONENTS, 'other'].map(k => [k, 0]));
    for (const a of actual) {
      const c = actualComponents(a, player.position, gameState.rules);
      for (const k of Object.keys(components)) components[k] += c[k];
    }
    rows.push({
      projectedComponents: r.pointsBreakdown || null,
      actualComponents: components,
      // Anyone with minutes this season or last is a player a model has to rank.
      // Decided from the archive by the caller, never from a model's own
      // GameState, so two engines are ranked over the same players.
      rankable: rankable ? rankable.has(id) : player.minutes > 0,
      gw,
      id,
      position: player.position,
      fixtures: r.fixtures.length,
      xPoints: r.xPoints,
      pStart: r.pStart,
      pAppear: r.pAppear,
      xMins: r.xMins,
      points: actual.reduce((s, x) => s + x.totalPoints, 0),
      minutes: actual.reduce((s, x) => s + x.minutes, 0),
      started: actual.some(x => x.starts > 0) ? 1 : 0,
      appeared: actual.some(x => x.minutes > 0) ? 1 : 0,
      // Started every club match so far THIS season, read off the payload's own
      // current-season totals, which is what a manager calls nailed.
      everPresent: m > 0 && (player.seasonStarts || 0) >= m,
      clubMatches: m,
    });
  }
  return rows;
}

function logLoss(rows, key, outcome) {
  const eps = 1e-6;
  return mean(rows.map(r => {
    const p = Math.min(1 - eps, Math.max(eps, r[key]));
    return -(r[outcome] ? Math.log(p) : Math.log(1 - p));
  }));
}

export function summarize(rows, xiList) {
  const single = rows.filter(r => r.fixtures === 1);
  const ever = single.filter(r => r.everPresent);
  const pool = rows.filter(r => r.xPoints > 0.5).sort((a, b) => a.xPoints - b.xPoints);
  const q = Math.floor(pool.length / 5);
  const quint = (i) => pool.slice(i * q, i === 4 ? pool.length : (i + 1) * q);
  const likely = rows.filter(r => r.pStart > 0.5).map(r => r.xPoints).sort((a, b) => a - b);
  const group = (set) => ({
    n: set.length,
    pStart: mean(set.map(r => r.pStart)),
    started: mean(set.map(r => r.started)),
    pAppear: mean(set.map(r => r.pAppear)),
    appeared: mean(set.map(r => r.appeared)),
    xMins: mean(set.map(r => r.xMins)),
    minutes: mean(set.map(r => r.minutes)),
    xPoints: mean(set.map(r => r.xPoints)),
    points: mean(set.map(r => r.points)),
  });
  const calibration = [];
  for (let i = 0; i < 10; i++) {
    const lo = i / 10;
    const hi = (i + 1) / 10;
    const set = single.filter(r => r.pStart >= lo && (i === 9 ? r.pStart <= 1 : r.pStart < hi));
    if (set.length) calibration.push({ bin: `${lo.toFixed(1)}-${hi.toFixed(1)}`, n: set.length, predicted: mean(set.map(r => r.pStart)), observed: mean(set.map(r => r.started)) });
  }
  const componentsFor = (set) => Object.fromEntries([...COMPONENTS, 'other'].map(k => [k, {
    projected: mean(set.map(r => (r.projectedComponents && Number.isFinite(r.projectedComponents[k]) ? r.projectedComponents[k] : 0))),
    actual: mean(set.map(r => r.actualComponents[k])),
  }]));
  // Rank correlation per deadline over a population fixed by the data, not by
  // either model (see `rankable`), then averaged.
  const byDeadline = new Map();
  for (const r of rows) {
    if (!r.rankable) continue;
    const key = `${r.season || ''}|${r.gw}`;
    if (!byDeadline.has(key)) byDeadline.set(key, []);
    byDeadline.get(key).push(r);
  }
  const correlations = [...byDeadline.values()]
    .map(set => rankCorrelation(set.map(r => r.xPoints), set.map(r => r.points)))
    .filter(Number.isFinite);
  const top = pool.length >= 5 ? quint(4) : [];
  return {
    players: rows.length,
    rankCorrelation: correlations.length ? mean(correlations) : NaN,
    components: {
      everPresent: componentsFor(ever),
      topQuintile: componentsFor(top),
      byPosition: Object.fromEntries([1, 2, 3, 4].map(p => [POSITION[p], componentsFor(single.filter(r => r.position === p && r.minutes > 0))])),
    },
    everPresent: group(ever),
    everPresentByPosition: Object.fromEntries([1, 2, 3, 4].map(p => [POSITION[p], group(ever.filter(r => r.position === p))])),
    rotation: group(single.filter(r => !r.everPresent && r.clubMatches > 0 && r.pStart > 0.05)),
    bottomQuintile: pool.length >= 5 ? group(quint(0)) : null,
    topQuintile: pool.length >= 5 ? group(quint(4)) : null,
    startCalibration: calibration,
    startLogLoss: logLoss(single, 'pStart', 'started'),
    appearLogLoss: logLoss(single, 'pAppear', 'appeared'),
    likelyStarters: likely.length
      ? { n: likely.length, p10: quantile(likely, 0.1), median: quantile(likely, 0.5), p90: quantile(likely, 0.9), max: likely[likely.length - 1] }
      : null,
    bestEleven: xiList.length
      ? { projected: mean(xiList.map(x => x.projected)), actual: mean(xiList.map(x => x.actual)) }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Reference baselines
// ---------------------------------------------------------------------------

export const REFERENCE_METHODS = ['ptsPerClubMatch', 'ppgSeason', 'ppgLast5'];
const METHODS = ['engine', ...REFERENCE_METHODS];
const PREMIUM_TENTHS = 70;

/**
 * Naive predictions for one season, built ONLY from gameweeks already absorbed.
 * The caller predicts gameweek g, then absorbs g, exactly as the replay's own
 * accumulator does, so a baseline can never read the gameweek it predicts.
 *
 * `prior` is the previous season's dataset (or null): its per-player points
 * per row, joined on the permanent `code`, are the fallback for a player with
 * no rows yet this season. A player with no prior row by code is a new signing.
 */
export function createReferenceTracker(dataset, prior = null) {
  const priorByCode = new Map();
  if (prior) {
    for (const [, gwMap] of prior.byGw) {
      for (const [pid, list] of gwMap) {
        const p = prior.players.get(pid);
        if (!p || p.code === null || p.code === undefined) continue;
        const e = priorByCode.get(p.code) || { points: 0, rows: 0 };
        for (const r of list) { e.points += r.totalPoints; e.rows += 1; }
        priorByCode.set(p.code, e);
      }
    }
  }
  const hist = new Map();
  const absorbed = new Set();
  return {
    absorb(gw) {
      if (absorbed.has(gw)) return;
      absorbed.add(gw);
      for (const [pid, list] of dataset.byGw.get(gw) || []) {
        const h = hist.get(pid) || { points: 0, rows: 0, minutes: 0, apps: [] };
        for (const r of list) {
          h.points += r.totalPoints;
          h.rows += 1;
          h.minutes += r.minutes;
          if (r.minutes > 0) h.apps.push(r.totalPoints);
        }
        hist.set(pid, h);
      }
    },
    /** Predictions for a player with `fixtures` matches in the next gameweek. */
    predict(id, fixtures) {
      const h = hist.get(id);
      const p = dataset.players.get(id);
      const pc = p && p.code !== null && p.code !== undefined ? priorByCode.get(p.code) : undefined;
      const perMatch = h && h.rows > 0 ? h.points / h.rows : (pc && pc.rows ? pc.points / pc.rows : 0);
      const apps = h ? h.apps : [];
      return {
        ptsPerClubMatch: perMatch * fixtures,
        ppgSeason: (apps.length ? mean(apps) : 0) * fixtures,
        ppgLast5: (apps.length ? mean(apps.slice(-5)) : 0) * fixtures,
        newSigning: !pc,
        // Season-to-date minutes per club match registered, null before a row.
        minutesPerMatch: h && h.rows ? h.minutes / h.rows : null,
      };
    },
  };
}

const predictionOf = (r, m) => (m === 'engine' ? r.xPoints : r.reference ? r.reference[m] : NaN);

function byDeadline(rows) {
  const out = new Map();
  for (const r of rows) {
    const key = `${r.season || ''}|${r.gw}`;
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(r);
  }
  return out;
}

// The top n of one deadline by a method's prediction, ties broken by player id
// so two runs pick the same players.
const topBy = (set, m, n) => [...set].sort((a, b) => predictionOf(b, m) - predictionOf(a, m) || a.id - b.id).slice(0, n);

/** One deadline's ranking facts for a method: Spearman, top 20, captain. */
function deadlineFacts(set, m) {
  const rankable = set.filter(r => r.rankable);
  const premium = set.filter(r => r.price >= PREMIUM_TENTHS);
  return {
    spearman: rankCorrelation(rankable.map(r => predictionOf(r, m)), rankable.map(r => r.points)),
    top20: mean(topBy(set, m, 20).map(r => r.points)),
    captain: set.length ? topBy(set, m, 1)[0].points : NaN,
    captainPremium: premium.length ? topBy(premium, m, 1)[0].points : NaN,
    top20Premium: premium.length ? mean(topBy(premium, m, 20).map(r => r.points)) : NaN,
  };
}

/**
 * Accuracy and ranking metrics for every method over the same rows. Rows
 * without a reference prediction (a run with --no-reference) score only the
 * engine.
 */
export function referenceMetrics(rows, methods = METHODS) {
  const out = {};
  const deadlines = byDeadline(rows);
  for (const m of methods) {
    const scored = rows.filter(r => Number.isFinite(predictionOf(r, m)));
    const err = scored.map(r => predictionOf(r, m) - r.points);
    const long = scored.filter(r => r.minutes >= 60);
    const per = [...deadlines.values()].map(set => deadlineFacts(set.filter(r => Number.isFinite(predictionOf(r, m))), m));
    const avg = (k) => mean(per.map(d => d[k]).filter(Number.isFinite));
    out[m] = {
      n: scored.length,
      bias: mean(err),
      mae: mean(err.map(Math.abs)),
      rmse: Math.sqrt(mean(err.map(e => e * e))),
      mae60: mean(long.map(r => Math.abs(predictionOf(r, m) - r.points))),
      bias60: mean(long.map(r => predictionOf(r, m) - r.points)),
      spearman: avg('spearman'),
      top20: avg('top20'),
      captain: avg('captain'),
      captainPremium: avg('captainPremium'),
      deadlines: per.length,
    };
  }
  return out;
}

const standardError = (a) => (a.length > 1
  ? Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1) / a.length)
  : NaN);

function pairedStat(diffs) {
  const d = diffs.filter(Number.isFinite);
  return {
    n: d.length,
    mean: mean(d),
    se: standardError(d),
    wins: d.filter(x => x > 0).length,
    losses: d.filter(x => x < 0).length,
    ties: d.filter(x => x === 0).length,
  };
}

/**
 * The engine minus a baseline, deadline by deadline on identical rows: rank
 * correlation, top-20 actual points, captain points and the top 20 among
 * players priced 7.0m+. The deadline is the unit, so the standard error is
 * over deadlines, never over player rows.
 */
export function pairedDifferences(rows, baseline, against = 'engine') {
  const spearman = [];
  const top20 = [];
  const captain = [];
  const top20Premium = [];
  for (const set of byDeadline(rows).values()) {
    const usable = set.filter(r => Number.isFinite(predictionOf(r, baseline)) && Number.isFinite(predictionOf(r, against)));
    if (!usable.length) continue;
    const a = deadlineFacts(usable, against);
    const b = deadlineFacts(usable, baseline);
    spearman.push(a.spearman - b.spearman);
    top20.push(a.top20 - b.top20);
    captain.push(a.captain - b.captain);
    top20Premium.push(a.top20Premium - b.top20Premium);
  }
  return {
    against,
    baseline,
    spearman: pairedStat(spearman),
    top20: pairedStat(top20),
    captain: pairedStat(captain),
    top20Premium: pairedStat(top20Premium),
  };
}

/** The tables the reference section prints, as data, in print order. */
export function referenceSections(rows, { seasons = [] } = {}) {
  const after = (g) => rows.filter(r => r.gw >= g);
  const fromTwo = after(2);
  const sections = [
    { key: 'all', title: 'All gameweeks', rows },
    { key: 'gw2+', title: 'GW 2 on (every baseline has some history)', rows: fromTwo },
    ...seasons.map(s => ({ key: `season:${s}`, title: `${s}, GW 2 on`, rows: fromTwo.filter(r => r.season === s) })),
    ...BUCKETS.map(([a, b]) => ({ key: `gw${a}-${b}`, title: `GW ${a}-${b}`, rows: rows.filter(r => r.gw >= a && r.gw <= b) })),
    ...[1, 2, 3, 4].map(p => ({ key: `position:${POSITION[p]}`, title: `${POSITION[p]}, GW 2 on`, rows: fromTwo.filter(r => r.position === p) })),
    { key: 'newSignings', title: 'New signings (no previous-season row by code), GW 2 on', rows: fromTwo.filter(r => r.newSigning) },
    { key: 'returning', title: 'Returning players, GW 2 on', rows: fromTwo.filter(r => r.newSigning === false) },
    {
      key: 'lowMinutes',
      title: 'Low minutes (season to date under 30 per club match), GW 4 on',
      rows: after(4).filter(r => r.minutesPerMatch !== null && r.minutesPerMatch !== undefined && r.minutesPerMatch < 30),
    },
    {
      key: 'regulars',
      title: 'Regulars (season to date 60+ per club match), GW 4 on',
      rows: after(4).filter(r => r.minutesPerMatch !== null && r.minutesPerMatch !== undefined && r.minutesPerMatch >= 60),
    },
    { key: 'doubleGameweek', title: 'Double-gameweek rows, every gameweek', rows: rows.filter(r => r.fixtures === 2) },
  ];
  return sections.filter(s => s.rows.length);
}

// Whether the evidence at each deadline carried ANY expected-goals data: the
// previous season's, or a gameweek of this season's before the deadline.
function expectedEvidenceFrom(dataset, prior) {
  const missing = new Set(dataset.expectedDataMissing || []);
  const priorMissing = new Set((prior && prior.expectedDataMissing) || []);
  const priorHas = prior ? [...prior.byGw.keys()].some(gw => !priorMissing.has(gw)) : false;
  if (priorHas) return 1;
  for (let gw = 1; gw <= dataset.maxGw; gw++) {
    if (dataset.byGw.has(gw) && !missing.has(gw)) return gw + 1;
  }
  return Infinity;
}

export async function runSeason(season, { gwFrom = 1, gwTo = 38, modelOptions = null, reference = true } = {}) {
  const priorName = previousSeason(season);
  const dataset = loadSeason(season);
  let prior = null;
  try { prior = priorName ? loadSeason(priorName) : null; } catch { prior = null; }
  if (!prior) return null;
  const rules = loadRules(season);
  const accumulator = createAccumulator(dataset, {});
  const preseasonTotals = preseasonTotalsFor(dataset, prior);
  const asset = priorSeasonAsset(dataset, prior, { firstDeadline: eventDeadlines(dataset).get(1) });
  const tracker = reference ? createReferenceTracker(dataset, prior) : null;
  // Only handed to the builders when asked for, so a run without the flag
  // calls them exactly as before.
  const extra = modelOptions ? { modelOptions } : {};
  // An odds candidate (`modelOptions.odds`) reads each deadline's bookmaker
  // prices off the GameState, attached exactly as the replay attaches them
  // (js/engine/backtest.js plannerDecide). Loaded only when asked for.
  let attachOdds = null;
  if (modelOptions && modelOptions.odds) {
    const { loadReplayOdds } = await import('./lib/odds-football-data.mjs');
    const { fixtureOddsAtDeadline } = await import('../js/engine/odds.js');
    const oddsRows = loadReplayOdds(dataset, season);
    attachOdds = (gameState, gw) => { gameState.fixtureOdds = fixtureOddsAtDeadline(oddsRows, gameState, gw).odds; };
  }
  const byGw = new Map();
  const last = Math.min(gwTo, dataset.maxGw);
  for (let gw = 1; gw <= last; gw++) {
    if (gw >= gwFrom) {
      const { gameState } = productionGameStateAt(dataset, gw, { rules, accumulator, preseasonTotals, asset });
      if (attachOdds) attachOdds(gameState, gw);
      const strength = buildStrength(gameState, { asOfGw: gw, ...extra });
      const projections = buildProjections({ gameState, strength, gwFrom: gw, gwTo: gw, ...extra });
      const rankable = new Set();
      for (const p of dataset.players.values()) {
        const now = accumulator.totalsFor(p.id);
        const last = preseasonTotals.get(p.id);
        if ((now && now.minutes > 0) || (last && last.minutes > 0)) rankable.add(p.id);
      }
      const actual = dataset.byGw.get(gw) || new Map();
      const rows = scoreDeadline({ dataset, gw, gameState, projections, rankable }).map((r) => {
        const out = { ...r, season };
        if (tracker) {
          const ref = tracker.predict(r.id, r.fixtures);
          const own = actual.get(r.id);
          out.reference = { ptsPerClubMatch: ref.ptsPerClubMatch, ppgSeason: ref.ppgSeason, ppgLast5: ref.ppgLast5 };
          out.newSigning = ref.newSigning;
          out.minutesPerMatch = ref.minutesPerMatch;
          out.price = own && own.length ? own[0].valueTenths : null;
        }
        return out;
      });
      if (rows.length) byGw.set(gw, { rows, xi: bestEleven(rows) });
    }
    accumulator.absorb(gw);
    if (tracker) tracker.absorb(gw);
  }
  return { season, byGw, expectedEvidenceFrom: expectedEvidenceFrom(dataset, prior) };
}

function fmt(v, d = 2) {
  return Number.isFinite(v) ? v.toFixed(d) : '-';
}

function printSummary(label, s) {
  const e = s.everPresent;
  console.log(`\n${label}  (${s.players} player-gameweeks)`);
  console.log(`  ever-present starters  n=${e.n}  pStart ${fmt(e.pStart)} vs started ${fmt(e.started)} | pAppear ${fmt(e.pAppear)} vs appeared ${fmt(e.appeared)} | xMins ${fmt(e.xMins, 1)} vs ${fmt(e.minutes, 1)} | xP ${fmt(e.xPoints)} vs ${fmt(e.points)}`);
  for (const [pos, g] of Object.entries(s.everPresentByPosition)) {
    console.log(`    ${pos.padEnd(3)} n=${String(g.n).padStart(4)}  pStart ${fmt(g.pStart)} vs ${fmt(g.started)} | xP ${fmt(g.xPoints)} vs ${fmt(g.points)}`);
  }
  const r = s.rotation;
  console.log(`  rotation / fringe      n=${r.n}  pStart ${fmt(r.pStart)} vs ${fmt(r.started)} | pAppear ${fmt(r.pAppear)} vs ${fmt(r.appeared)} | xP ${fmt(r.xPoints)} vs ${fmt(r.points)}`);
  if (s.topQuintile) console.log(`  top projection quintile     xP ${fmt(s.topQuintile.xPoints)} vs ${fmt(s.topQuintile.points)}`);
  if (s.bottomQuintile) console.log(`  bottom projection quintile  xP ${fmt(s.bottomQuintile.xPoints)} vs ${fmt(s.bottomQuintile.points)}`);
  if (s.likelyStarters) {
    const l = s.likelyStarters;
    console.log(`  xP of likely starters (pStart>0.5): p10 ${fmt(l.p10)} median ${fmt(l.median)} p90 ${fmt(l.p90)} max ${fmt(l.max)}`);
  }
  if (s.bestEleven) console.log(`  best XI by projection: projected ${fmt(s.bestEleven.projected, 1)}, those eleven scored ${fmt(s.bestEleven.actual, 1)}`);
  console.log(`  log loss: start ${fmt(s.startLogLoss, 4)}, appear ${fmt(s.appearLogLoss, 4)} | rank correlation xP vs points (per deadline) ${fmt(s.rankCorrelation, 3)}`);
  const line = (label, comps) => console.log(`  ${label.padEnd(26)} ${Object.entries(comps).map(([k, v]) => `${k} ${fmt(v.projected)}/${fmt(v.actual)}`).join('  ')}`);
  line('components, ever-present', s.components.everPresent);
  line('components, top quintile', s.components.topQuintile);
  for (const [pos, comps] of Object.entries(s.components.byPosition)) line(`components, ${pos} who played`, comps);
  console.log(`  start calibration: ${s.startCalibration.map(c => `${c.bin} ${fmt(c.predicted)}/${fmt(c.observed)} (${c.n})`).join('; ')}`);
}

function printReferenceTable(title, rows) {
  const m = referenceMetrics(rows);
  console.log(`\n### ${title}  (${rows.length} player-gameweeks)\n`);
  console.log('| method | n | bias | MAE | RMSE | MAE 60+ | bias 60+ | Spearman/GW | top-20 pts | captain pts | captain 7.0m+ |');
  console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const k of METHODS) {
    const x = m[k];
    console.log(`| ${k} | ${x.n} | ${fmt(x.bias, 3)} | ${fmt(x.mae, 3)} | ${fmt(x.rmse, 3)} | ${fmt(x.mae60, 3)} | ${fmt(x.bias60, 3)} | `
      + `${fmt(x.spearman, 3)} | ${fmt(x.top20)} | ${fmt(x.captain)} | ${fmt(x.captainPremium)} |`);
  }
  return m;
}

const pairedCell = (p) => `${fmt(p.mean, 3)} (${fmt(p.se, 3)}) ${p.wins}/${p.losses}/${p.ties}`;

/** Every season's buckets against the calibration bands, as data. */
export function checkSeasons(results) {
  const out = [];
  for (const run of results) {
    for (const [from, to] of BUCKETS) {
      const deadlines = [...run.byGw].filter(([gw]) => gw >= from && gw <= to);
      if (!deadlines.length) continue;
      const violations = calibrationViolations(calibrationFacts(deadlines.map(([, v]) => v.rows)));
      const noExpected = deadlines.some(([gw]) => gw < (run.expectedEvidenceFrom ?? 1));
      const gated = from >= 2 && !noExpected;
      out.push({
        season: run.season, from, to, gated, violations,
        reason: from < 2 ? 'gameweek 1' : (noExpected ? 'no expected-goals data in the evidence' : null),
      });
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const seasons = args.seasons || KNOWN_SEASONS;
  const results = [];
  const timings = {};
  for (const season of seasons) {
    const t0 = Date.now();
    const run = await runSeason(season, {
      gwFrom: args.gwFrom, gwTo: args.gwTo, modelOptions: args.modelOptions, reference: args.reference,
    });
    if (!run) {
      console.log(`${season}: skipped, no downloaded predecessor (production always has one)`);
      continue;
    }
    results.push(run);
    timings[season] = Date.now() - t0;
    console.log(`${season}: replayed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
  const out = {
    generatedAt: new Date().toISOString(),
    seasons: results.map(r => r.season),
    modelOptions: args.modelOptions,
    timingsMs: timings,
    buckets: {},
  };
  for (const [from, to] of BUCKETS) {
    if (to < args.gwFrom || from > args.gwTo) continue;
    const rows = [];
    const xis = [];
    for (const run of results) {
      for (const [gw, v] of run.byGw) {
        if (gw < from || gw > to) continue;
        rows.push(...v.rows);
        if (v.xi) xis.push(v.xi);
      }
    }
    if (!rows.length) continue;
    const s = summarize(rows, xis);
    out.buckets[`gw${from}-${to}`] = s;
    printSummary(`GW ${from}-${to}, seasons ${results.map(r => r.season).join(', ')}`, s);
  }

  if (args.check) {
    // Per season, never pooled across seasons: a band a season breaks is a
    // finding, and pooling would let two seasons' errors cancel.
    let broken = 0;
    console.log('\ncalibration bands (scripts/lib/calibration-guard.mjs):');
    const checks = checkSeasons(results);
    for (const c of checks) {
      if (c.gated) broken += c.violations.length;
      const note = c.gated ? '' : (c.reason === 'gameweek 1'
        ? ' (not gated: see the header)'
        : ' (not gated: no expected-goals data in the evidence, see the header)');
      console.log(`  ${c.season} GW ${c.from}-${c.to}: ${c.violations.length ? 'BREAKS' : 'ok'}${note}`);
      for (const v of c.violations) console.log(`    ${v.code}: ${v.message}`);
    }
    out.check = { broken, buckets: checks };
    if (broken) process.exitCode = 1;
  }

  if (args.reference) {
    const rows = [];
    for (const run of results) for (const [, v] of run.byGw) rows.push(...v.rows);
    console.log('\n## Reference baselines: the engine against naive rules on identical rows');
    console.log('Each baseline for gameweek g reads only gameweeks before g (and last season). Spearman is per deadline over the');
    console.log('rankable pool, averaged; top-20 and captain are the mean actual points of the top 20 and the top 1 by prediction.');
    out.reference = { tables: {}, paired: {} };
    for (const section of referenceSections(rows, { seasons: results.map(r => r.season) })) {
      out.reference.tables[section.key] = { title: section.title, rows: section.rows.length, metrics: printReferenceTable(section.title, section.rows) };
    }
    const fromTwo = rows.filter(r => r.gw >= 2);
    console.log('\n### Paired per deadline, engine minus baseline, GW 2 on: mean (standard error) wins/losses/ties\n');
    console.log('| baseline | deadlines | Spearman | top-20 pts | captain pts | top-20 among 7.0m+ |');
    console.log('|---|---:|---:|---:|---:|---:|');
    for (const b of REFERENCE_METHODS) {
      const p = pairedDifferences(fromTwo, b);
      out.reference.paired[b] = p;
      console.log(`| ${b} | ${p.top20.n} | ${pairedCell(p.spearman)} | ${pairedCell(p.top20)} | ${pairedCell(p.captain)} | ${pairedCell(p.top20Premium)} |`);
    }
    // Per-deadline series, so a reader can see where the engine wins and loses.
    out.reference.perDeadline = [...byDeadline(rows).entries()].map(([key, set]) => {
      const [season, gw] = key.split('|');
      return { season, gw: Number(gw), ...Object.fromEntries(METHODS.map(m => [m, deadlineFacts(set, m)])) };
    });
  }

  if (args.json) fs.writeFileSync(args.json, `${JSON.stringify(out, null, 1)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
