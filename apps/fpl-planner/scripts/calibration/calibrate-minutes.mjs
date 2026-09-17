#!/usr/bin/env node
// Minutes-model calibration on the replay archive: start probability, the
// chance of coming off the bench, and the chance of reaching 60 minutes.
//
// WHAT IS PREDICTED. For every player-fixture row of a target season (a
// registered player's club playing a fixture in gameweek g) the models predict
// whether he STARTED, whether he APPEARED, and, when he started, whether he
// reached 60 minutes.
//
// WHAT A PREDICTION MAY READ (the leakage rule). Only what production can hold
// at the gameweek g deadline:
//   - this season's totals over gameweeks strictly before g (starts, minutes),
//     which is exactly what bootstrap-static elements carry;
//   - how many matches the player's club has kicked off before g;
//   - last season's END-OF-SEASON totals for the same footballer, joined on
//     `code` (the shape of data/opening-baseline.json);
//   - the player's price at the deadline.
// No appearance counts and no per-match history: sub appearances are inferred
// from totals exactly as production has to. The archive carries no injury
// flags, so every row counts as available; production additionally caps
// flagged players, which this cannot model.
//
// HOW IT IS SCORED. Leave-one-season-out over the three target seasons that
// have a predecessor (2023-24, 2024-25, 2025-26): parameters are chosen on two
// seasons and scored on the third. 2026-27 is never read.
//
// COMPARATORS. The CURRENT production path is not re-implemented: each
// deadline's state is built in production's own shape and passed to the
// engine's projectMinutes, so "production" here is the shipped code:
//   production     last season's totals pre-season (gw1), last season overlaid
//                  at weight 1 until every club has played 3 matches, then this
//                  season only; K=6 toward the pooled position start rate.
//   overlayAlways  the same overlay kept for the whole season.
//
// Usage:
//   node apps/fpl-planner/scripts/calibration/calibrate-minutes.mjs
//
// Writes apps/fpl-planner/.data/calibration/minutes.json (gitignored).

import fs from 'node:fs';
import path from 'node:path';

import { loadSeason } from '../backtest.mjs';
import { DATA_DIR } from '../fetch-history.mjs';
import { resolveSeasonPair } from '../../js/engine/player-identity.js';
import { projectMinutes, p60FromMeanMinutes, MINUTES_PARAMS } from '../../js/engine/minutes.js';

const PAIRS = [['2022-23', '2023-24'], ['2023-24', '2024-25'], ['2024-25', '2025-26']];
const PRIOR_MATCHES = 38;
const EPS = 1e-4;
const CONGESTION = MINUTES_PARAMS.congestionStartFactor;
const GW_BUCKETS = [[1, 3], [4, 8], [9, 19], [20, 38]];
const POSITIONS = [1, 2, 3, 4];
const POS_NAME = { 1: 'GK', 2: 'DEF', 3: 'MID', 4: 'FWD' };
const OUT = path.join(DATA_DIR, 'calibration', 'minutes.json');

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clampP = (p) => (p < EPS ? EPS : p > 1 - EPS ? 1 - EPS : p);
const logit = (p) => Math.log(p / (1 - p));
const sig = (x) => 1 / (1 + Math.exp(-x));
const r3 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : v);
const r4 = (v) => (Number.isFinite(v) ? Math.round(v * 10000) / 10000 : v);

function lgamma(x) {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
const lbeta = (a, b) => lgamma(a) + lgamma(b) - lgamma(a + b);

function ll(p, y) {
  const q = clampP(p);
  return -(y ? Math.log(q) : Math.log(1 - q));
}

// ---------------------------------------------------------------------------
// Data preparation: one record per target-season player-fixture row.
// ---------------------------------------------------------------------------

function roster(d) {
  return { season: d.season, players: [...d.players.values()].map(p => ({ id: p.id, name: p.name, code: p.code })) };
}

function pricePercentile(sorted, cost) {
  if (!sorted || sorted.length < 2) return 0.5;
  let below = 0;
  for (const v of sorted) {
    if (v < cost) below++;
    else break;
  }
  return below / (sorted.length - 1);
}

function buildRecords(priorName, targetName, seasonIndex, joinStats) {
  const prior = loadSeason(priorName);
  const target = loadSeason(targetName);
  const join = resolveSeasonPair({ from: roster(prior), to: roster(target) });
  joinStats[targetName] = { matched: join.matched.size, players: target.players.size };

  const priorTotals = new Map();
  for (const [toId, entry] of join.matched) {
    const pp = prior.players.get(entry.id);
    if (!pp) continue;
    let s = 0;
    let m = 0;
    for (const r of pp.rows) { s += r.starts; m += r.minutes; }
    if (s > 0 || m > 0) priorTotals.set(toId, { s, m });
  }

  // Last season's pooled position rates over the footballers the baseline
  // would carry: target-season players with a previous-season record.
  const lastPool = new Map(POSITIONS.map(p => [p, { s: 0, m: 0, n: 0 }]));
  for (const [id, pr] of priorTotals) {
    const pl = target.players.get(id);
    if (!pl || !(pr.m > 0)) continue;
    const row = lastPool.get(pl.position);
    row.s += pr.s;
    row.m += pr.m;
    row.n += 1;
  }
  const posLast = new Map();
  const smLast = new Map();
  for (const [pos, row] of lastPool) {
    posLast.set(pos, row.n ? row.s / (row.n * PRIOR_MATCHES) : 0.35);
    smLast.set(pos, row.s ? Math.min(90, (row.m * 0.92) / row.s) : 80);
  }

  const clubEvents = new Map();
  for (const t of target.teams.keys()) clubEvents.set(t, []);
  for (const f of target.fixtures) {
    clubEvents.get(f.teamH).push(f.event);
    clubEvents.get(f.teamA).push(f.event);
  }
  const before = (team, g) => clubEvents.get(team).filter(e => e < g).length;
  const inGw = (team, g) => clubEvents.get(team).filter(e => e === g).length;

  const totals = new Map();
  const records = [];

  for (let g = 1; g <= target.maxGw; g++) {
    const rowsAtG = target.byGw.get(g);
    if (!rowsAtG) continue;

    const played = new Map();
    let minPlayed = Infinity;
    for (const t of target.teams.keys()) {
      const n = before(t, g);
      played.set(t, n);
      minPlayed = Math.min(minPlayed, n);
    }
    const superseded = minPlayed >= 3;

    const fixtures = target.fixtures.map(f => ({
      id: f.id,
      event: f.event,
      teamH: f.teamH,
      teamA: f.teamA,
      finished: f.event < g,
      finishedProvisional: f.event < g,
      started: f.event < g,
      teamHScore: f.event < g ? f.teamHScore : null,
      teamAScore: f.event < g ? f.teamAScore : null,
    }));

    const modeFor = (regime) => (g === 1 ? 'preseason' : (regime === 'overlayAlways' || !superseded ? 'overlay' : 'current'));
    const states = {};
    for (const regime of ['production', 'overlayAlways']) {
      const mode = modeFor(regime);
      const players = new Map();
      for (const [pid, rows] of rowsAtG) {
        const r = rows[0];
        const teamId = target.nameToId.get(r.teamName);
        if (!teamId) continue;
        const cur = totals.get(pid) || { S: 0, M: 0, SA: 0 };
        const pr = priorTotals.get(pid) || null;
        const p = { id: pid, position: r.position, teamId, nowCost: r.valueTenths, status: 'a', chanceNext: null };
        if (mode === 'preseason') {
          p.starts = pr ? pr.s : 0;
          p.minutes = pr ? pr.m : 0;
        } else if (mode === 'overlay') {
          const pl = played.get(teamId) || 0;
          if (pr) {
            p.starts = pr.s + cur.S;
            p.minutes = pr.m + cur.M;
            p.evidenceMatches = PRIOR_MATCHES + pl;
          } else {
            p.starts = cur.S;
            p.minutes = cur.M;
            p.evidenceMatches = pl || null;
          }
        } else {
          p.starts = cur.S;
          p.minutes = cur.M;
        }
        players.set(pid, p);
      }
      states[regime] = {
        rules: { totalEvents: PRIOR_MATCHES },
        teams: target.teams,
        players,
        fixtures,
        nextEvent: g,
        currentEvent: g > 1 ? g - 1 : null,
      };
    }

    // This season's pooled position rates, for the new estimators.
    const curPool = new Map(POSITIONS.map(p => [p, { s: 0, m: 0, mins: 0 }]));
    const bands = new Map(POSITIONS.map(p => [p, []]));
    for (const [pid, rows] of rowsAtG) {
      const r = rows[0];
      bands.get(r.position).push(r.valueTenths);
      const cur = totals.get(pid);
      const teamId = target.nameToId.get(r.teamName);
      if (!cur || !(cur.M > 0) || !teamId) continue;
      const row = curPool.get(r.position);
      row.s += cur.S;
      row.m += played.get(teamId) || 0;
      row.mins += cur.M;
    }
    for (const arr of bands.values()) arr.sort((a, b) => a - b);

    for (const [pid, rows] of rowsAtG) {
      const r0 = rows[0];
      const teamId = target.nameToId.get(r0.teamName);
      if (!teamId) continue;
      const cur = totals.get(pid) || { S: 0, M: 0, SA: 0 };
      const pr = priorTotals.get(pid) || null;
      const nFix = inGw(teamId, g);
      const pos = r0.position;
      const pool = curPool.get(pos);

      const eng = {};
      for (const regime of ['production', 'overlayAlways']) {
        const player = states[regime].players.get(pid);
        const mins = projectMinutes(player, { gameState: states[regime], gw: g, fixtureCount: nFix });
        eng[regime] = {
          pStart: mins.pStart,
          pAppear: mins.pAppear,
          msm: mins.meanStarterMinutes,
        };
      }

      for (const r of rows) {
        records.push({
          season: seasonIndex,
          g,
          pos,
          m: played.get(teamId) || 0,
          nFix,
          s: cur.S,
          M: cur.M,
          subAppsTrue: cur.SA,
          hasPrior: !!pr,
          sL: pr ? pr.s : 0,
          ML: pr ? pr.m : 0,
          pct: pricePercentile(bands.get(pos), r0.valueTenths),
          posLast: posLast.get(pos),
          smLast: smLast.get(pos),
          smCur: pool.s > 0 ? Math.min(90, (pool.mins * 0.92) / pool.s) : smLast.get(pos),
          started: r.starts > 0 ? 1 : 0,
          appeared: r.minutes > 0 ? 1 : 0,
          minutes: r.minutes,
          p0s: eng.production.pStart,
          p0a: eng.production.pAppear,
          msm0: eng.production.msm,
          pbs: eng.overlayAlways.pStart,
          pba: eng.overlayAlways.pAppear,
        });
      }
    }

    for (const [pid, rows] of rowsAtG) {
      if (!totals.has(pid)) totals.set(pid, { S: 0, M: 0, SA: 0 });
      const t = totals.get(pid);
      for (const r of rows) {
        t.S += r.starts;
        t.M += r.minutes;
        if (!r.starts && r.minutes > 0) t.SA += 1;
      }
    }
  }
  return records;
}

// ---------------------------------------------------------------------------
// Start probability
// ---------------------------------------------------------------------------

function priorMean(rec, prm) {
  let mu = (rec.sL + prm.K0 * rec.posLast) / (PRIOR_MATCHES + prm.K0);
  if (prm.cal) mu = sig(prm.cal.a + prm.cal.b * logit(clampP(mu)));
  return mu;
}

const lbetaCache = new Map();
function lbetaTable(a, b) {
  const key = `${a}|${b}`;
  if (lbetaCache.has(key)) return lbetaCache.get(key);
  const base = lbeta(a, b);
  const t = new Float64Array(41 * 41);
  for (let m = 0; m <= 40; m++) {
    for (let s = 0; s <= m; s++) t[m * 41 + s] = lbeta(s + a, m - s + b) - base;
  }
  lbetaCache.set(key, t);
  return t;
}

const mixtureTables = new WeakMap();

function noPriorMean(rec, s, np) {
  if (np.variant === 'price') {
    const mu = np.lo + rec.pct * (np.hi - np.lo);
    const K = np.k1 !== undefined ? np.k0 + np.k1 * rec.m : np.K;
    return (s + K * mu) / (rec.m + K);
  }
  if (np.variant === 'posConst') {
    const mu = np.mu[rec.pos];
    return (s + np.K * mu) / (rec.m + np.K);
  }
  // Two-component regular/fringe beta mixture, component weight from price.
  const si = Math.round(s);
  const mi = Math.min(40, rec.m);
  const w = sig(np.w0 + np.w1 * (rec.pct - 0.5));
  const a1 = np.r1 * np.c;
  const a2 = np.r2 * np.c;
  let tables = mixtureTables.get(np);
  if (!tables) {
    tables = [lbetaTable(a1, (1 - np.r1) * np.c), lbetaTable(a2, (1 - np.r2) * np.c)];
    mixtureTables.set(np, tables);
  }
  const l1 = tables[0][mi * 41 + Math.min(si, mi)];
  const l2 = tables[1][mi * 41 + Math.min(si, mi)];
  const mx = Math.max(l1, l2);
  const p1 = w * Math.exp(l1 - mx);
  const p2 = (1 - w) * Math.exp(l2 - mx);
  const z = p1 + p2;
  return (p1 * (s + a1) + p2 * (s + a2)) / (z * (rec.m + np.c));
}

function predictStart(rec, prm) {
  const s = Math.min(rec.s, rec.m);
  const K = prm.k1 !== undefined ? prm.k0 + prm.k1 * rec.m : prm.K;
  let p = rec.hasPrior ? (s + K * priorMean(rec, prm)) / (rec.m + K) : noPriorMean(rec, s, prm.np);
  if (rec.nFix > 1) p *= CONGESTION;
  return clamp01(p);
}

function seasonLosses(records, filter, predict, nSeasons = 3) {
  const out = Array.from({ length: nSeasons }, () => ({ ll: 0, brier: 0, n: 0 }));
  for (const rec of records) {
    if (!filter(rec)) continue;
    const p = predict(rec);
    const y = rec.y;
    const o = out[rec.season];
    o.ll += ll(p, y);
    o.brier += (p - y) * (p - y);
    o.n += 1;
  }
  return out;
}

// Leave-one-season-out: for each held-out season pick the candidate with the
// lowest summed log loss on the other seasons.
function loso(cands, losses) {
  const folds = [];
  for (let h = 0; h < 3; h++) {
    let best = null;
    for (let i = 0; i < cands.length; i++) {
      let s = 0;
      let n = 0;
      for (let t = 0; t < 3; t++) {
        if (t === h) continue;
        s += losses[i][t].ll;
        n += losses[i][t].n;
      }
      const v = s / n;
      if (!best || v < best.v) best = { i, v };
    }
    folds.push(best.i);
  }
  let pooled = null;
  for (let i = 0; i < cands.length; i++) {
    const s = losses[i].reduce((a, o) => a + o.ll, 0) / losses[i].reduce((a, o) => a + o.n, 0);
    if (!pooled || s < pooled.v) pooled = { i, v: s };
  }
  return { folds, pooled: pooled.i };
}

function summarize(rows, key) {
  let lsum = 0;
  let bsum = 0;
  let psum = 0;
  let ysum = 0;
  for (const r of rows) {
    lsum += ll(r[key], r.y);
    bsum += (r[key] - r.y) ** 2;
    psum += r[key];
    ysum += r.y;
  }
  const n = rows.length || 1;
  return { n: rows.length, logLoss: r4(lsum / n), brier: r4(bsum / n), meanPred: r3(psum / n), actual: r3(ysum / n) };
}

function deciles(rows, key) {
  const bins = Array.from({ length: 10 }, (_, i) => ({ bin: `${i / 10}-${(i + 1) / 10}`, n: 0, p: 0, y: 0 }));
  for (const r of rows) {
    const b = bins[Math.min(9, Math.floor(r[key] * 10))];
    b.n++;
    b.p += r[key];
    b.y += r.y;
  }
  return bins.filter(b => b.n).map(b => ({ bin: b.bin, n: b.n, pred: r3(b.p / b.n), actual: r3(b.y / b.n) }));
}

const K_GRID = [0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 15, 20, 30];
const K0_GRID = [0, 1, 2, 3, 4, 6, 8, 12, 19, 38];

const K0_LIN = [0.25, 0.5, 0.75, 1];
const K1_LIN = [0.05, 0.1, 0.125, 0.15, 0.2, 0.25];

function fitStartLinear(records) {
  const priorRows = (rec) => rec.hasPrior;
  const noPriorRows = (rec) => !rec.hasPrior;
  const priorCands = [];
  for (const k0 of K0_LIN) {
    for (const k1 of K1_LIN) {
      for (const K0 of [6, 8, 12]) {
        for (const a of [-0.8, -0.6, -0.4, -0.2]) {
          for (const b of [0.5, 0.6, 0.7, 0.8]) {
            priorCands.push({ k0, k1, K0, cal: { a, b } });
          }
        }
      }
    }
  }
  const priorLoss = priorCands.map(c => seasonLosses(records, priorRows, rec => predictStart(rec, c)));
  const priorSel = loso(priorCands, priorLoss);
  const cands = [];
  for (const lo of [0.02, 0.05, 0.08]) {
    for (const hi of [0.45, 0.6, 0.78]) {
      for (const k0 of [0.25, 0.5, 0.75, 1, 1.5]) {
        for (const k1 of [0, 0.025, 0.05, 0.1, 0.15]) cands.push({ variant: 'price', lo, hi, k0, k1 });
      }
    }
  }
  const losses = cands.map(np => seasonLosses(records, noPriorRows, rec => predictStart(rec, { np })));
  const families = { price: { cands, losses, sel: loso(cands, losses) } };
  let hs = 0;
  let hn = 0;
  families.price.sel.folds.forEach((i, h) => { hs += losses[i][h].ll; hn += losses[i][h].n; });
  return { priorCands, priorLoss, priorSel, families, familyHeldOut: { price: { heldOutLogLoss: r4(hs / hn), n: hn } }, bestFamily: 'price' };
}

// Two stages, nested inside each fold. Stage 1 calibrates the prior mean where
// it is the WHOLE prediction (gameweek 1, no current-season evidence). Stage 2
// fits how fast current-season evidence takes over, with stage 1 frozen.
function fitStartTwoStage(records) {
  const A = [];
  for (let a = -1; a <= 1.001; a += 0.1) A.push(r3(a));
  const B = [];
  for (let b = 0.5; b <= 1.801; b += 0.1) B.push(r3(b));
  const stage1Cands = [];
  for (const K0 of [0, 2, 4, 6, 8, 12, 19]) for (const a of A) for (const b of B) stage1Cands.push({ K0, cal: { a, b } });
  const npStage1 = [];
  for (const lo of [0, 0.01, 0.02, 0.05, 0.08, 0.12]) for (const hi of [0.2, 0.3, 0.45, 0.6, 0.78, 0.9]) npStage1.push({ lo, hi });
  const K0S = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3];
  const K1S = [0, 0.05, 0.1, 0.125, 0.15, 0.2, 0.25, 0.3, 0.4];

  const gw1Prior = (r) => r.g === 1 && r.hasPrior;
  const gw1NoPrior = (r) => r.g === 1 && !r.hasPrior;
  const s1Loss = stage1Cands.map(c => seasonLosses(records, gw1Prior, rec => clamp01(priorMean(rec, c) * (rec.nFix > 1 ? CONGESTION : 1))));
  const np1Loss = npStage1.map(c => seasonLosses(records, gw1NoPrior, rec => clamp01((c.lo + rec.pct * (c.hi - c.lo)) * (rec.nFix > 1 ? CONGESTION : 1))));

  const pick = (losses, exclude) => {
    let best = null;
    losses.forEach((l, i) => {
      let s = 0;
      let n = 0;
      for (let t = 0; t < 3; t++) if (t !== exclude) { s += l[t].ll; n += l[t].n; }
      if (n && (!best || s / n < best.v)) best = { i, v: s / n };
    });
    return best.i;
  };

  const fold = (exclude) => {
    const s1 = stage1Cands[pick(s1Loss, exclude)];
    const n1 = npStage1[pick(np1Loss, exclude)];
    const priorC = [];
    for (const k0 of K0S) for (const k1 of K1S) priorC.push({ ...s1, k0, k1 });
    const priorL = priorC.map(c => seasonLosses(records, r => r.hasPrior, rec => predictStart(rec, c)));
    const npC = [];
    for (const k0 of K0S) for (const k1 of K1S) npC.push({ variant: 'price', ...n1, k0, k1 });
    const npL = npC.map(np => seasonLosses(records, r => !r.hasPrior, rec => predictStart(rec, { np })));
    return { ...priorC[pick(priorL, exclude)], np: npC[pick(npL, exclude)] };
  };
  return { folds: [0, 1, 2].map(h => fold(h)), pooled: fold(-1) };
}

function fitStart(records) {
  const priorRows = (rec) => rec.hasPrior;
  const noPriorRows = (rec) => !rec.hasPrior;

  // Players WITH a previous-season record: carry strength K, prior shrink K0.
  let priorCands = [];
  for (const K of K_GRID) for (const K0 of K0_GRID) priorCands.push({ K, K0, cal: null });
  let priorLoss = priorCands.map(c => seasonLosses(records, priorRows, rec => predictStart(rec, c)));
  const first = loso(priorCands, priorLoss);
  const bestNoCal = priorCands[first.pooled];
  const calCands = [];
  const ki = K_GRID.indexOf(bestNoCal.K);
  const k0i = K0_GRID.indexOf(bestNoCal.K0);
  for (const K of K_GRID.slice(Math.max(0, ki - 1), ki + 2)) {
    for (const K0 of K0_GRID.slice(Math.max(0, k0i - 1), k0i + 2)) {
      for (let a = -0.8; a <= 0.801; a += 0.2) {
        for (let b = 0.7; b <= 1.601; b += 0.1) calCands.push({ K, K0, cal: { a: r3(a), b: r3(b) } });
      }
    }
  }
  const calLoss = calCands.map(c => seasonLosses(records, priorRows, rec => predictStart(rec, c)));
  priorCands = priorCands.concat(calCands);
  priorLoss = priorLoss.concat(calLoss);
  const priorSel = loso(priorCands, priorLoss);

  // Players WITHOUT one: three prior families for the no-history mean.
  const families = {};
  {
    const cands = [];
    for (const lo of [0, 0.02, 0.05, 0.08, 0.12, 0.2]) {
      for (const hi of [0.3, 0.45, 0.6, 0.78, 0.9]) {
        for (const K of K_GRID) cands.push({ variant: 'price', lo, hi, K });
      }
    }
    const losses = cands.map(np => seasonLosses(records, noPriorRows, rec => predictStart(rec, { np })));
    families.price = { cands, losses, sel: loso(cands, losses) };
  }
  {
    // Position constants: chosen per position for each K, inside each fold.
    const MU = [0.01, 0.02, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7];
    const cands = [];
    const losses = [];
    const perPos = new Map();
    for (const K of K_GRID) {
      for (const pos of POSITIONS) {
        for (const mu of MU) {
          const np = { variant: 'posConst', K, mu: { 1: mu, 2: mu, 3: mu, 4: mu } };
          perPos.set(`${K}|${pos}|${mu}`, seasonLosses(records, rec => noPriorRows(rec) && rec.pos === pos, rec => predictStart(rec, { np })));
        }
      }
    }
    // Enumerate one candidate per (K, fold): best mu per position on the fold's
    // training seasons, plus the pooled choice.
    const foldChoice = (K, exclude) => {
      const mu = {};
      for (const pos of POSITIONS) {
        let best = null;
        for (const m of MU) {
          const l = perPos.get(`${K}|${pos}|${m}`);
          let s = 0;
          for (let t = 0; t < 3; t++) if (t !== exclude) s += l[t].ll;
          if (!best || s < best.s) best = { s, m };
        }
        mu[pos] = best.m;
      }
      return mu;
    };
    for (const K of K_GRID) {
      for (const exclude of [0, 1, 2, -1]) {
        const mu = foldChoice(K, exclude);
        const np = { variant: 'posConst', K, mu, fittedExcluding: exclude };
        cands.push(np);
        losses.push(seasonLosses(records, noPriorRows, rec => predictStart(rec, { np })));
      }
    }
    // Held-out selection must only consider candidates whose mu was chosen
    // without the held-out season.
    const folds = [];
    for (let h = 0; h < 3; h++) {
      let best = null;
      cands.forEach((c, i) => {
        if (c.fittedExcluding !== h) return;
        let s = 0;
        let n = 0;
        for (let t = 0; t < 3; t++) if (t !== h) { s += losses[i][t].ll; n += losses[i][t].n; }
        if (!best || s / n < best.v) best = { i, v: s / n };
      });
      folds.push(best.i);
    }
    let pooled = null;
    cands.forEach((c, i) => {
      if (c.fittedExcluding !== -1) return;
      const v = losses[i].reduce((a, o) => a + o.ll, 0) / losses[i].reduce((a, o) => a + o.n, 0);
      if (!pooled || v < pooled.v) pooled = { i, v };
    });
    families.posConst = { cands, losses, sel: { folds, pooled: pooled.i } };
  }
  {
    const cands = [];
    for (const r1 of [0.75, 0.85, 0.92]) {
      for (const r2 of [0.02, 0.05, 0.1, 0.2]) {
        for (const c of [2, 4, 8, 16, 32]) {
          for (const w0 of [-3, -2, -1, 0, 1]) {
            for (const w1 of [0, 2, 4, 6, 8]) cands.push({ variant: 'mixture', r1, r2, c, w0, w1 });
          }
        }
      }
    }
    const losses = cands.map(np => seasonLosses(records, noPriorRows, rec => predictStart(rec, { np })));
    families.mixture = { cands, losses, sel: loso(cands, losses) };
  }

  // Held-out log loss per family, summed over the three held-out seasons.
  const familyHeldOut = {};
  for (const [name, fam] of Object.entries(families)) {
    let s = 0;
    let n = 0;
    fam.sel.folds.forEach((i, h) => { s += fam.losses[i][h].ll; n += fam.losses[i][h].n; });
    familyHeldOut[name] = { heldOutLogLoss: r4(s / n), n };
  }
  const bestFamily = Object.entries(familyHeldOut).sort((a, b) => a[1].heldOutLogLoss - b[1].heldOutLogLoss)[0][0];

  return { priorCands, priorLoss, priorSel, families, familyHeldOut, bestFamily };
}

// ---------------------------------------------------------------------------
// Appearance: P(appears from the bench | did not start)
// ---------------------------------------------------------------------------

const Q_EDGES = [0, 0.05, 0.15, 0.3, 0.5, 0.7, 0.85, 1.0001];
const qBin = (p) => {
  for (let i = Q_EDGES.length - 2; i >= 0; i--) if (p >= Q_EDGES[i]) return i;
  return 0;
};

// Pool-adjacent-violators: non-decreasing across bins, weighted by counts.
function pav(values, weights) {
  const blocks = values.map((v, i) => ({ v, w: weights[i], n: 1 }));
  for (let i = 0; i < blocks.length - 1;) {
    if (blocks[i].v > blocks[i + 1].v) {
      const w = blocks[i].w + blocks[i + 1].w;
      const v = w > 0 ? (blocks[i].v * blocks[i].w + blocks[i + 1].v * blocks[i + 1].w) / w : (blocks[i].v + blocks[i + 1].v) / 2;
      blocks.splice(i, 2, { v, w, n: blocks[i].n + blocks[i + 1].n });
      if (i > 0) i--;
    } else {
      i++;
    }
  }
  const out = [];
  for (const b of blocks) for (let k = 0; k < b.n; k++) out.push(b.v);
  return out;
}

function qTable(records, seasons, pKey) {
  const table = {};
  const raw = {};
  for (const pos of POSITIONS) {
    const n = new Array(Q_EDGES.length - 1).fill(0);
    const a = new Array(Q_EDGES.length - 1).fill(0);
    for (const rec of records) {
      if (rec.pos !== pos || !seasons.includes(rec.season) || rec.started) continue;
      const b = qBin(rec[pKey]);
      n[b]++;
      a[b] += rec.appeared;
    }
    const tot = a.reduce((x, y) => x + y, 0) / Math.max(1, n.reduce((x, y) => x + y, 0));
    const smoothed = n.map((c, i) => (a[i] + tot) / (c + 1));
    raw[pos] = n.map((c, i) => ({ bin: `${Q_EDGES[i]}-${Math.min(1, Q_EDGES[i + 1])}`, n: c, rate: c ? r3(a[i] / c) : null }));
    table[pos] = pav(smoothed, n);
  }
  // Players with NO minutes this season after at least one club match, by
  // position and matches played: not being used at all is itself evidence,
  // and the bin table above cannot see it.
  const zero = {};
  for (const pos of POSITIONS) {
    zero[pos] = Z_BUCKETS.map(([lo, hi]) => {
      let n = 0;
      let a = 0;
      for (const rec of records) {
        if (rec.pos !== pos || !seasons.includes(rec.season) || rec.started) continue;
        if (rec.M !== 0 || rec.m < lo || rec.m > hi) continue;
        n++;
        a += rec.appeared;
      }
      return (a + 0.5 * 0.02) / (n + 0.5);
    });
  }
  return { table, raw, zero };
}

const Z_BUCKETS = [[1, 2], [3, 5], [6, 10], [11, 99]];
const zBucket = (m) => Z_BUCKETS.findIndex(([lo, hi]) => m >= lo && m <= hi);

function subApps(total, starts, matches, smPrior, subMin, estimator) {
  const opportunities = Math.max(0, matches - starts);
  if (opportunities <= 0) return { apps: 0, opportunities: 0 };
  const bench = estimator === 'bound'
    ? Math.max(0, total - 90 * starts)
    : Math.max(0, total - Math.min(total, starts * smPrior));
  return { apps: Math.min(opportunities, bench / subMin), opportunities };
}

function subOnRate(rec, prm, q, subMin, zero = null) {
  const s = Math.min(rec.s, rec.m);
  if (prm.zeroSplit && zero && rec.M === 0 && rec.m >= 1) return zero[rec.pos][zBucket(rec.m)];
  const cur = subApps(rec.M, s, rec.m, rec.smCur, subMin, prm.est);
  const last = rec.hasPrior
    ? subApps(rec.ML, rec.sL, PRIOR_MATCHES, rec.smLast, subMin, prm.est)
    : { apps: 0, opportunities: 0 };
  const num = cur.apps + prm.wL * last.apps + prm.k * q;
  const den = cur.opportunities + prm.wL * last.opportunities + prm.k;
  return den > 0 ? clamp01(num / den) : q;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const joinStats = {};
  const records = [];
  PAIRS.forEach(([prior, target], i) => {
    const t0 = Date.now();
    const recs = buildRecords(prior, target, i, joinStats);
    for (const r of recs) records.push(r);
    console.log(`${target}: ${recs.length} rows prepared in ${Date.now() - t0} ms`);
  });
  const seasonNames = PAIRS.map(p => p[1]);

  // ---- start ----
  for (const r of records) r.y = r.started;
  const start = fitStart(records);
  const famBest = start.families[start.bestFamily];
  const heldOutParams = [0, 1, 2].map(h => ({
    ...start.priorCands[start.priorSel.folds[h]],
    np: famBest.cands[famBest.sel.folds[h]],
  }));
  const pooledParams = { ...start.priorCands[start.priorSel.pooled], np: famBest.cands[famBest.sel.pooled] };
  for (const r of records) r.p1s = predictStart(r, heldOutParams[r.season]);

  // The constant-K form above is kept as a comparator. The linear form lets the
  // carry strength grow with the matches already played, which is what the
  // per-bucket K optimum asked for (see kStabilityWithPriorRecord).
  const constHeld = summarize(records, 'p1s');
  const startLin = fitStartLinear(records);
  const famLin = startLin.families.price;
  const heldOutLin = [0, 1, 2].map(h => ({ ...startLin.priorCands[startLin.priorSel.folds[h]], np: famLin.cands[famLin.sel.folds[h]] }));
  const pooledLin = { ...startLin.priorCands[startLin.priorSel.pooled], np: famLin.cands[famLin.sel.pooled] };
  for (const r of records) r.p2s = predictStart(r, heldOutLin[r.season]);
  const linHeld = summarize(records, 'p2s');
  const useLinear = linHeld.logLoss < constHeld.logLoss;

  const twoStage = fitStartTwoStage(records);
  for (const r of records) r.p3s = predictStart(r, twoStage.folds[r.season]);
  const twoHeld = summarize(records, 'p3s');

  // The chosen form: the two-stage fit unless it costs more than 0.002 of
  // held-out log loss against the best single-stage form, because a prior that
  // is miscalibrated at gameweek 1 mis-states every pre-season plan.
  const bestSingle = useLinear ? { held: heldOutLin, pooled: pooledLin, key: 'p2s', ll: linHeld.logLoss } : { held: heldOutParams, pooled: pooledParams, key: 'p1s', ll: constHeld.logLoss };
  const useTwoStage = twoHeld.logLoss <= bestSingle.ll + 0.002;
  const chosenHeld = useTwoStage ? twoStage.folds : bestSingle.held;
  const chosenPooled = useTwoStage ? twoStage.pooled : bestSingle.pooled;
  const chosenForm = useTwoStage ? 'two-stage: prior mean calibrated at gw1, then K = k0 + k1 * clubMatches' : (useLinear ? 'linear K' : 'constant K');
  for (const r of records) r.pcs = useTwoStage ? r.p3s : r[bestSingle.key];

  const startCompare = {
    production: summarize(records.map(r => ({ ...r, p: r.p0s })), 'p'),
    overlayAlways: summarize(records.map(r => ({ ...r, p: r.pbs })), 'p'),
    candidateConstK: summarize(records, 'p1s'),
    candidateLinearK: summarize(records, 'p2s'),
    candidateTwoStage: summarize(records, 'p3s'),
    candidate: summarize(records, 'pcs'),
  };
  const byBucket = {};
  for (const [lo, hi] of GW_BUCKETS) {
    const rows = records.filter(r => r.g >= lo && r.g <= hi);
    byBucket[`gw${lo}-${hi}`] = {
      splitByPriorRecord: Object.fromEntries([true, false].map(hp => {
        const sub = rows.filter(r => r.hasPrior === hp);
        return [hp ? 'withPrior' : 'withoutPrior', { production: summarize(sub, 'p0s'), candidate: summarize(sub, 'pcs') }];
      })),
      production: summarize(rows, 'p0s'),
      overlayAlways: summarize(rows, 'pbs'),
      candidateConstK: summarize(rows, 'p1s'),
      candidateLinearK: summarize(rows, 'p2s'),
      candidateTwoStage: summarize(rows, 'p3s'),
      candidate: summarize(rows, 'pcs'),
    };
  }
  const bySeason = {};
  seasonNames.forEach((name, i) => {
    const rows = records.filter(r => r.season === i);
    bySeason[name] = { production: summarize(rows, 'p0s'), overlayAlways: summarize(rows, 'pbs'), candidateConstK: summarize(rows, 'p1s'), candidateLinearK: summarize(rows, 'p2s'), candidateTwoStage: summarize(rows, 'p3s'), candidate: summarize(rows, 'pcs') };
  });
  const decileTables = { production: deciles(records, 'p0s'), overlayAlways: deciles(records, 'pbs'), candidateConstK: deciles(records, 'p1s'), candidate: deciles(records, 'pcs') };

  const everPresent = [];
  for (let m = 1; m <= 6; m++) {
    for (const pos of POSITIONS) {
      for (const hp of [true, false]) {
        const rows = records.filter(r => r.m === m && Math.min(r.s, r.m) === m && r.pos === pos && r.hasPrior === hp && r.nFix === 1);
        if (!rows.length) continue;
        everPresent.push({
          m, pos: POS_NAME[pos], prior: hp, n: rows.length, actual: r3(rows.reduce((a, r) => a + r.y, 0) / rows.length),
          production: r3(rows.reduce((a, r) => a + r.p0s, 0) / rows.length),
          overlayAlways: r3(rows.reduce((a, r) => a + r.pbs, 0) / rows.length),
          candidateConstK: r3(rows.reduce((a, r) => a + r.p1s, 0) / rows.length),
          candidate: r3(rows.reduce((a, r) => a + r.pcs, 0) / rows.length),
        });
      }
    }
  }
  const everPresentByPos = POSITIONS.map(pos => {
    const rows = records.filter(r => r.m >= 1 && r.m <= 6 && Math.min(r.s, r.m) === r.m && r.pos === pos && r.nFix === 1);
    return {
      pos: POS_NAME[pos], n: rows.length, actual: r3(rows.reduce((a, r) => a + r.y, 0) / rows.length),
      production: r3(rows.reduce((a, r) => a + r.p0s, 0) / rows.length),
      overlayAlways: r3(rows.reduce((a, r) => a + r.pbs, 0) / rows.length),
      candidateConstK: r3(rows.reduce((a, r) => a + r.p1s, 0) / rows.length),
      candidate: r3(rows.reduce((a, r) => a + r.pcs, 0) / rows.length),
    };
  });

  // Gameweek 1, where the prior IS the prediction: by last season's start count.
  const gw1ByPriorStarts = [[0, 0], [1, 9], [10, 19], [20, 29], [30, 38]].map(([lo, hi]) => {
    const rows = records.filter(r => r.g === 1 && r.hasPrior && r.sL >= lo && r.sL <= hi);
    if (!rows.length) return null;
    const mean = (k) => r3(rows.reduce((a, r) => a + r[k], 0) / rows.length);
    return { lastSeasonStarts: `${lo}-${hi}`, n: rows.length, actual: mean('y'), production: mean('p0s'), constK: mean('p1s'), linearK: mean('p2s'), twoStage: mean('p3s') };
  }).filter(Boolean);

  // Stability: the K each season and each gameweek bucket would choose alone,
  // with K0 and the calibration map held at the pooled choice.
  const pooledPrior = start.priorCands[start.priorSel.pooled];
  const kStability = [];
  for (let s = 0; s < 3; s++) {
    const row = { season: seasonNames[s] };
    for (const [lo, hi] of GW_BUCKETS) {
      let best = null;
      const curve = [];
      for (const K of K_GRID) {
        const c = { ...pooledPrior, K };
        let l = 0;
        let n = 0;
        for (const rec of records) {
          if (rec.season !== s || !rec.hasPrior || rec.g < lo || rec.g > hi) continue;
          l += ll(predictStart(rec, c), rec.y);
          n++;
        }
        curve.push(r4(l / n));
        if (!best || l < best.l) best = { K, l };
      }
      row[`gw${lo}-${hi}`] = best.K;
      row[`curve_gw${lo}-${hi}`] = curve;
    }
    kStability.push(row);
  }
  const knewStability = [];
  if (start.bestFamily !== 'posConst') {
    const pooledNp = famBest.cands[famBest.sel.pooled];
    for (let s = 0; s < 3; s++) {
      const row = { season: seasonNames[s] };
      for (const [lo, hi] of GW_BUCKETS) {
        let best = null;
        for (const K of K_GRID) {
          const np = { ...pooledNp, K };
          if (np.variant === 'mixture') np.c = K; // concentration plays K's role
          let l = 0;
          for (const rec of records) {
            if (rec.season !== s || rec.hasPrior || rec.g < lo || rec.g > hi) continue;
            l += ll(predictStart(rec, { np }), rec.y);
          }
          if (!best || l < best.l) best = { K, l };
        }
        row[`gw${lo}-${hi}`] = best.K;
      }
      knewStability.push(row);
    }
  }

  // ---- appearance ----
  let subMinSum = 0;
  let subMinN = 0;
  for (const r of records) {
    if (!r.started && r.minutes > 0) { subMinSum += r.minutes; subMinN++; }
  }
  const subMinAll = subMinSum / subMinN;
  const appearCands = [];
  for (const est of ['resid', 'bound']) {
    for (const k of [0.25, 0.5, 1, 2, 3, 5, 8, 12, 20, 40, 100, 1e6]) {
      for (const wL of [0, 0.05, 0.1, 0.25, 0.5, 1]) {
        for (const zeroSplit of [false, true]) appearCands.push({ est, k, wL, zeroSplit });
      }
    }
  }
  const appearFolds = [];
  for (let h = 0; h < 3; h++) {
    const train = [0, 1, 2].filter(t => t !== h);
    // Training-fold subMin and q table, on the fold's own start predictions.
    let sm = 0;
    let sn = 0;
    for (const r of records) if (r.season !== h && !r.started && r.minutes > 0) { sm += r.minutes; sn++; }
    const subMin = sm / sn;
    for (const r of records) r.pf = predictStart(r, chosenHeld[h]);
    const q = qTable(records, train, 'pf');
    let best = null;
    const lossesByCand = appearCands.map(c => {
      let l = 0;
      let n = 0;
      let lh = 0;
      let nh = 0;
      for (const r of records) {
        if (r.started) continue;
        const v = subOnRate(r, c, q.table[r.pos][qBin(r.pf)], subMin, q.zero);
        if (r.season === h) { lh += ll(v, r.appeared); nh++; } else { l += ll(v, r.appeared); n++; }
      }
      return { train: l / n, held: lh / nh };
    });
    lossesByCand.forEach((v, i) => { if (!best || v.train < best.train) best = { i, ...v }; });
    const chosen = appearCands[best.i];
    for (const r of records) {
      if (r.season !== h) continue;
      const qv = q.table[r.pos][qBin(r.pcs)];
      r.subOn1 = subOnRate(r, chosen, qv, subMin, q.zero);
      r.p1a = clamp01(r.pcs + (1 - r.pcs) * r.subOn1);
      r.qOnly = clamp01(r.pcs + (1 - r.pcs) * qv);
    }
    appearFolds.push({ heldOut: seasonNames[h], chosen, subMin: r3(subMin), heldOutSubOnLogLoss: r4(best.held), qTable: q.table, qRaw: q.raw });
  }
  // Pooled fit for the recommendation.
  const pooledAppear = (() => {
    for (const r of records) r.pf = predictStart(r, chosenPooled);
    const q = qTable(records, [0, 1, 2], 'pf');
    let best = null;
    for (const c of appearCands) {
      let l = 0;
      let n = 0;
      for (const r of records) {
        if (r.started) continue;
        l += ll(subOnRate(r, c, q.table[r.pos][qBin(r.pf)], subMinAll, q.zero), r.appeared);
        n++;
      }
      if (!best || l / n < best.v) best = { c, v: l / n };
    }
    return { chosen: best.c, subMin: r3(subMinAll), qTable: q.table, qRaw: q.raw, zero: q.zero };
  })();

  const notStarted = records.filter(r => !r.started);
  const subOnCompare = {
    production: summarize(notStarted.map(r => ({ y: r.appeared, p: r.p0s < 1 ? clamp01((r.p0a - r.p0s) / (1 - r.p0s)) : 0 })), 'p'),
    candidate: summarize(notStarted.map(r => ({ y: r.appeared, p: r.subOn1 })), 'p'),
  };
  const appearRows = records.map(r => ({ ...r, y: r.appeared }));
  const everAppear = (rows) => rows.filter(r => r.m >= 2 && Math.min(r.s, r.m) === r.m);
  const rotAppear = (rows) => rows.filter(r => r.m >= 2 && r.s / r.m >= 0.25 && r.s / r.m <= 0.75 && r.subAppsTrue >= 1);
  const appearCompare = {
    all: { production: summarize(appearRows, 'p0a'), overlayAlways: summarize(appearRows, 'pba'), candidate: summarize(appearRows, 'p1a'), candidateQOnly: summarize(appearRows, 'qOnly') },
    everPresent: { production: summarize(everAppear(appearRows), 'p0a'), candidate: summarize(everAppear(appearRows), 'p1a') },
    rotationWithSubApps: { production: summarize(rotAppear(appearRows), 'p0a'), candidate: summarize(rotAppear(appearRows), 'p1a') },
  };
  // Players with no minutes at all this season, after 3+ club matches: the
  // group a heavily shrunk sub-on rate is most likely to overstate.
  const zeroMinutes = (rows) => rows.filter(r => r.m >= 3 && r.M === 0);
  appearCompare.zeroMinutesAfter3 = {
    production: summarize(zeroMinutes(appearRows), 'p0a'),
    candidate: summarize(zeroMinutes(appearRows), 'p1a'),
    candidateQOnly: summarize(zeroMinutes(appearRows), 'qOnly'),
  };
  appearCompare.zeroMinutesAfter3WithPrior = {
    production: summarize(zeroMinutes(appearRows).filter(r => r.hasPrior), 'p0a'),
    candidate: summarize(zeroMinutes(appearRows).filter(r => r.hasPrior), 'p1a'),
  };
  const appearByBucket = {};
  for (const [lo, hi] of GW_BUCKETS) {
    const rows = appearRows.filter(r => r.g >= lo && r.g <= hi);
    appearByBucket[`gw${lo}-${hi}`] = {
      everPresent: { production: summarize(everAppear(rows), 'p0a'), candidate: summarize(everAppear(rows), 'p1a') },
      rotation: { production: summarize(rotAppear(rows), 'p0a'), candidate: summarize(rotAppear(rows), 'p1a') },
    };
  }

  // Inversion: per (season, gameweek, position) cell, does the median
  // ever-present pAppear sit below the median rotation pAppear?
  const inversion = {};
  for (const key of ['p0a', 'p1a']) {
    const cells = new Map();
    for (const r of appearRows) {
      const ep = r.m >= 2 && Math.min(r.s, r.m) === r.m;
      const rot = r.m >= 2 && r.s / r.m >= 0.25 && r.s / r.m <= 0.75 && r.subAppsTrue >= 1;
      if (!ep && !rot) continue;
      const id = `${r.season}|${r.g}|${r.pos}`;
      if (!cells.has(id)) cells.set(id, { ep: [], rot: [] });
      cells.get(id)[ep ? 'ep' : 'rot'].push(r[key]);
    }
    const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    let compared = 0;
    let inverted = 0;
    let worst = 0;
    let rowsBelow = 0;
    let rowsTotal = 0;
    for (const c of cells.values()) {
      if (c.ep.length < 3 || c.rot.length < 3) continue;
      compared++;
      const gap = median(c.rot) - median(c.ep);
      if (gap > 0.02) inverted++;
      worst = Math.max(worst, gap);
      const rotMed = median(c.rot);
      for (const v of c.ep) { rowsTotal++; if (v < rotMed - 0.02) rowsBelow++; }
    }
    inversion[key === 'p0a' ? 'production' : 'candidate'] = {
      cellsCompared: compared,
      cellsWhereRotationMedianExceedsEverPresentBy2pts: inverted,
      worstGap: r3(worst),
      everPresentRowsBelowRotationMedian: rowsTotal ? r3(rowsBelow / rowsTotal) : null,
    };
  }

  // ---- P(60+ | started) ----
  const started = records.filter(r => r.started);
  for (const r of started) {
    const s = r.s;
    const curApps = subApps(r.M, Math.min(r.s, r.m), r.m, r.smCur, subMinAll, 'bound').apps;
    const rawCur = s >= 1 ? Math.min(90, Math.max(1, (r.M - curApps * subMinAll) / s)) : null;
    const lastApps = r.hasPrior ? subApps(r.ML, r.sL, PRIOR_MATCHES, r.smLast, subMinAll, 'bound').apps : 0;
    const rawLast = r.sL >= 1 ? Math.min(90, Math.max(1, (r.ML - lastApps * subMinAll) / r.sL)) : null;
    const target = rawLast !== null ? (r.sL * rawLast + 5 * r.smLast) / (r.sL + 5) : (r.m > 0 ? r.smCur : r.smLast);
    r.msm1 = rawCur !== null ? (s * rawCur + 5 * target) / (s + 5) : target;
    r.y60 = r.minutes >= 60 ? 1 : 0;
  }
  const MID = [];
  for (let v = 30; v <= 90; v += 2) MID.push(v);
  const SCALE = [2, 3, 4, 6, 8, 10, 12, 15, 20, 25, 30];
  const p60Fit = {};
  for (const pos of POSITIONS) {
    const rows = started.filter(r => r.pos === pos);
    const fitFor = (key) => {
      const cands = [];
      const losses = [];
      for (const mid of MID) {
        for (const scale of SCALE) {
          cands.push({ mid, scale });
          const out = [0, 1, 2].map(() => ({ ll: 0, n: 0 }));
          for (const r of rows) {
            const p = sig((r[key] - mid) / scale);
            out[r.season].ll += ll(p, r.y60);
            out[r.season].n++;
          }
          losses.push(out);
        }
      }
      const sel = loso(cands, losses);
      let lh = 0;
      let nh = 0;
      sel.folds.forEach((i, h) => { lh += losses[i][h].ll; nh += losses[i][h].n; });
      return { pooled: cands[sel.pooled], folds: sel.folds.map(i => cands[i]), heldOutLogLoss: r4(lh / nh) };
    };
    const base = rows.map(r => ({ y: r.y60, p: p60FromMeanMinutes(r.msm0) }));
    const constant = (() => {
      let lh = 0;
      for (let h = 0; h < 3; h++) {
        const tr = rows.filter(r => r.season !== h);
        const rate = tr.reduce((a, r) => a + r.y60, 0) / tr.length;
        for (const r of rows) if (r.season === h) lh += ll(rate, r.y60);
      }
      return { rate: r3(rows.reduce((a, r) => a + r.y60, 0) / rows.length), heldOutLogLoss: r4(lh / rows.length) };
    })();
    const fitProdMsm = fitFor('msm0');
    const fitNewMsm = fitFor('msm1');
    const bins = [[0, 60], [60, 70], [70, 78], [78, 84], [84, 88], [88, 91]];
    const table = bins.map(([lo, hi]) => {
      const b = rows.filter(r => r.msm0 >= lo && r.msm0 < hi);
      if (!b.length) return null;
      return {
        msm: `${lo}-${hi}`, n: b.length, actual: r3(b.reduce((a, r) => a + r.y60, 0) / b.length),
        current: r3(b.reduce((a, r) => a + p60FromMeanMinutes(r.msm0), 0) / b.length),
        fitted: r3(b.reduce((a, r) => a + sig((r.msm0 - fitProdMsm.pooled.mid) / fitProdMsm.pooled.scale), 0) / b.length),
      };
    }).filter(Boolean);
    p60Fit[POS_NAME[pos]] = {
      n: rows.length,
      actualRate: constant.rate,
      current: summarize(base, 'p'),
      constant,
      fittedOnProductionMsm: fitProdMsm,
      fittedOnCarryMsm: fitNewMsm,
      calibrationByProductionMsm: table,
    };
  }

  // ---- conditional minutes (descriptive, all three target seasons) ----
  const conditional = {};
  for (const pos of POSITIONS) {
    const rows = records.filter(r => r.pos === pos);
    const st = rows.filter(r => r.started);
    const stUnder = st.filter(r => r.minutes < 60);
    const stOver = st.filter(r => r.minutes >= 60);
    const sub = rows.filter(r => !r.started && r.minutes > 0);
    const subOver = sub.filter(r => r.minutes >= 60);
    const subUnder = sub.filter(r => r.minutes < 60);
    const mean = (a) => (a.length ? r3(a.reduce((x, r) => x + r.minutes, 0) / a.length) : null);
    conditional[POS_NAME[pos]] = {
      started: st.length,
      p60GivenStart: r3(stOver.length / st.length),
      meanMinutesStartedUnder60: mean(stUnder),
      meanMinutesStartedOver60: mean(stOver),
      subAppearances: sub.length,
      meanSubMinutes: mean(sub),
      p60GivenSub: r3(subOver.length / Math.max(1, sub.length)),
      meanSubMinutesOver60: mean(subOver),
      meanSubMinutesUnder60: mean(subUnder),
    };
  }

  const out = {
    script: 'apps/fpl-planner/scripts/calibration/calibrate-minutes.mjs',
    seasons: PAIRS.map(([p, t]) => ({ prior: p, target: t })),
    joinStats,
    rows: records.length,
    // Last season's pooled start rate per position (sum of starts over 38
    // matches per player with minutes), the mu_pos the prior mean shrinks to.
    priorPoolStartRate: Object.fromEntries(PAIRS.map(([, t], i) => [t, Object.fromEntries(POSITIONS.map(pos => {
      const r = records.find(x => x.season === i && x.pos === pos);
      return [POS_NAME[pos], r ? r3(r.posLast) : null];
    }))])),
    start: {
      recommended: chosenPooled,
      recommendedForm: chosenForm,
      twoStagePooled: twoStage.pooled,
      constantKPooled: pooledParams,
      linearKPooled: pooledLin,
      heldOutFoldParams: chosenHeld.map((p, i) => ({ heldOut: seasonNames[i], ...p })),
      heldOutFoldParamsConstantK: heldOutParams.map((p, i) => ({ heldOut: seasonNames[i], ...p })),
      noPriorFamilies: start.familyHeldOut,
      bestNoPriorFamily: start.bestFamily,
      heldOut: startCompare,
      heldOutBySeason: bySeason,
      heldOutByGwBucket: byBucket,
      decileCalibration: decileTables,
      everPresentByPosition: everPresentByPos,
      gameweek1ByLastSeasonStarts: gw1ByPriorStarts,
      everPresent: everPresent,
      kStabilityWithPriorRecord: kStability,
      kNewStabilityWithoutPriorRecord: knewStability,
      kGrid: K_GRID,
    },
    appear: {
      recommended: { ...pooledAppear.chosen, subMin: pooledAppear.subMin, qTable: pooledAppear.qTable, zeroMinuteTable: pooledAppear.zero, zeroMinuteBuckets: Z_BUCKETS },
      qTableRawRates: pooledAppear.qRaw,
      folds: appearFolds.map(f => ({ heldOut: f.heldOut, chosen: f.chosen, subMin: f.subMin, heldOutSubOnLogLoss: f.heldOutSubOnLogLoss })),
      heldOutSubOn: subOnCompare,
      heldOutAppear: appearCompare,
      heldOutAppearByGwBucket: appearByBucket,
      inversion,
    },
    p60: p60Fit,
    conditionalMinutes: conditional,
    currentConstants: {
      startRateShrinkMatches: MINUTES_PARAMS.startRateShrinkMatches,
      p60Midpoint: MINUTES_PARAMS.p60Midpoint,
      p60Scale: MINUTES_PARAMS.p60Scale,
      startUnder60Minutes: 40,
      subMinutes: 20,
      subOver60Minutes: 68,
    },
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`);

  // ---- compact console report ----
  const line = (label, o) => console.log(`  ${label.padEnd(16)} n=${String(o.n).padStart(6)} logloss ${o.logLoss} brier ${o.brier} pred ${o.meanPred} actual ${o.actual}`);
  console.log('\nSTART, held out (leave-one-season-out)');
  for (const [k, v] of Object.entries(startCompare)) line(k, v);
  console.log('  constant-K pooled:', JSON.stringify(pooledParams), 'folds:', JSON.stringify(heldOutParams));
  console.log('  linear-K pooled:', JSON.stringify(pooledLin), 'folds:', JSON.stringify(heldOutLin));
  console.log('  two-stage pooled:', JSON.stringify(twoStage.pooled), 'folds:', JSON.stringify(twoStage.folds));
  console.log('  chosen form:', chosenForm);
  console.log('  no-prior families:', JSON.stringify(start.familyHeldOut));
  for (const [b, v] of Object.entries(byBucket)) {
    console.log(`  ${b}: withPrior prod ${v.splitByPriorRecord.withPrior.production.logLoss} cand ${v.splitByPriorRecord.withPrior.candidate.logLoss} | withoutPrior prod ${v.splitByPriorRecord.withoutPrior.production.logLoss} cand ${v.splitByPriorRecord.withoutPrior.candidate.logLoss} (n ${v.splitByPriorRecord.withPrior.production.n}/${v.splitByPriorRecord.withoutPrior.production.n})`);
    console.log(`  ${b}: production ${v.production.logLoss}/${v.production.brier}  overlayAlways ${v.overlayAlways.logLoss}/${v.overlayAlways.brier}  constK ${v.candidateConstK.logLoss}/${v.candidateConstK.brier}  linearK ${v.candidateLinearK.logLoss}/${v.candidateLinearK.brier}  twoStage ${v.candidateTwoStage.logLoss}/${v.candidateTwoStage.brier}`);
  }
  console.log('  ever-presents m=1..6 by position (pred vs actual):');
  for (const r of everPresentByPos) console.log(`    ${r.pos.padEnd(4)} n=${r.n} actual ${r.actual} production ${r.production} overlayAlways ${r.overlayAlways} constK ${r.candidateConstK} chosen ${r.candidate}`);
  console.log('  gw1 by last-season starts:', JSON.stringify(gw1ByPriorStarts));
  console.log('  K stability (with prior record):', JSON.stringify(kStability.map(r => Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('curve'))))));
  console.log('  Knew stability (no prior record):', JSON.stringify(knewStability));
  console.log('\nAPPEAR');
  console.log('  subOn held out:', JSON.stringify(subOnCompare));
  for (const [k, v] of Object.entries(appearCompare)) console.log(`  ${k}:`, JSON.stringify(v));
  console.log('  recommended:', JSON.stringify(pooledAppear.chosen), 'subMin', pooledAppear.subMin);
  console.log('  folds:', JSON.stringify(appearFolds.map(f => ({ h: f.heldOut, c: f.chosen }))));
  console.log('  inversion:', JSON.stringify(inversion));
  console.log('\nP60 | started');
  for (const [pos, v] of Object.entries(p60Fit)) {
    console.log(`  ${pos.padEnd(4)} actual ${v.actualRate} current ll ${v.current.logLoss} constant ll ${v.constant.heldOutLogLoss} fit(prodMsm) ${JSON.stringify(v.fittedOnProductionMsm.pooled)} ll ${v.fittedOnProductionMsm.heldOutLogLoss} fit(carryMsm) ${JSON.stringify(v.fittedOnCarryMsm.pooled)} ll ${v.fittedOnCarryMsm.heldOutLogLoss}`);
  }
  console.log('\nCONDITIONAL MINUTES');
  for (const [pos, v] of Object.entries(conditional)) console.log(`  ${pos.padEnd(4)}`, JSON.stringify(v));
  console.log(`\nWrote ${OUT}`);
}

main();
