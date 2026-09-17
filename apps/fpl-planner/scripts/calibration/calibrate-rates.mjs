#!/usr/bin/env node
// Rate calibration for the projection model: how much of a player's previous
// season to carry into this one, per quantity, and how to turn xA into FPL
// assists and BPS into bonus.
//
// THE QUESTION. projections.js shrinks every per-90 rate toward the player's
// POSITION mean with a fixed k, and production discards last season entirely
// once every club has played three matches. This script measures, leakage-free
// on the archive, whether a PLAYER-SPECIFIC prior built from last season
// predicts better, and with what strengths.
//
// THE LEAKAGE RULE. A prediction at the deadline of gameweek g reads only
//   - this season's rows with gw < g (what bootstrap-static totals carry), and
//   - the previous season's FULL totals, joined on `code` (what the opening
//     baseline carries).
// The target is what the player does AFTER the deadline: his next five
// appearances (minutes > 0, gw >= g), summed, with minutes as the exposure.
// Nothing about the future enters a predictor, and parameters are fitted
// leave-one-season-out over the target seasons, so every reported number is
// out of sample for the season it describes.
//
// Models compared, per quantity and position (rates are per 90):
//   (a) PRODUCTION: (evidence + posMean * kProd) / (evidence 90s + kProd), with
//       evidence = last season + this season while fewer than three matches
//       have been played by some club, this season alone after that, and kProd
//       the shipped PRIOR_NINETIES. For FPL assists and goals production
//       projects the xA and xG rate, so (a) is that rate.
//   (b) PLAYER PRIOR: prior_i = (last + posMeanLast * k0) / (last90s + k0),
//       rate = (cur + prior_i * kc) / (cur90s + kc) for a returner, optionally
//       capping kc at the prior's own evidence (last90s + k0); a player with
//       no previous-season record gets (cur + posNow * kNew) / (cur90s + kNew).
//   (c) DISCOUNTED SEASON: rate = (cur + w * last + posNow * k) /
//       (cur90s + w * last90s + k), the same newcomer branch.
//   (bs), (cs) the same two with last season's totals rescaled by
//       posNow / posLast, so a player prior is RELATIVE to his position's level
//       and survives a league-wide change in how a quantity is scored.
// Metric: Poisson deviance of the next-five count with exposure = next-five
// nineties. D2 is 1 - deviance / deviance of a constant position mean.
//
// Usage:
//   node apps/fpl-planner/scripts/calibration/calibrate-rates.mjs
// Writes apps/fpl-planner/.data/calibration/rates.json (gitignored with the
// rest of .data) and prints the compact tables.

import fs from 'node:fs';
import path from 'node:path';
import { loadSeason } from '../backtest.mjs';
import { DATA_DIR, identityPath } from '../fetch-history.mjs';
import { parseCsv } from '../../js/engine/backtest.js';
import { calibrate } from '../../js/engine/ml.js';
import { priorNinetiesFor } from '../../js/engine/projections.js';

const ALL_SEASONS = ['2022-23', '2023-24', '2024-25', '2025-26'];
const TARGETS = ['2023-24', '2024-25', '2025-26'];
const POSITION_NAMES = { 1: 'GK', 2: 'DEF', 3: 'MID', 4: 'FWD' };
const NEXT_APPEARANCES = 5;
// The newcomer target blends this season's position pool with last season's
// rate, anchored at two gameweeks' worth of that position's minutes, so a
// league whose scoring level moved (FPL rewrote BPS for 2024-25) is followed
// within a few gameweeks rather than half a season.
const POOL_ANCHOR_GAMEWEEKS = 2;
const EARLY = [2, 8];
const BASELINE_RETIRE_MATCHES = 3;

// Production's bonus curve: isotonic bins on raw bps/90 -> bonus/90 over players
// with at least this many rate minutes, else the linear fallback.
const BONUS_MIN_MINUTES = 450;
const BONUS_BINS = 12;
const BONUS_FALLBACK = (bps90) => Math.max(0, (bps90 - 7) * 0.035);
const MAX_BONUS = 3;

// Row vector layout.
const F = { min: 0, xMin: 1, dcMin: 2, xG: 3, xA: 4, assists: 5, goals: 6, bps: 7, bonus: 8, saves: 9, defCon: 10, yellow: 11 };
const NF = 12;

const QUANTITIES = {
  xG: { field: F.xG, expo: F.xMin, positions: [2, 3, 4], prodKey: 'xG', prodField: F.xG, prodExpo: F.xMin },
  xA: { field: F.xA, expo: F.xMin, positions: [1, 2, 3, 4], prodKey: 'xA', prodField: F.xA, prodExpo: F.xMin },
  assists: { field: F.assists, expo: F.min, positions: [2, 3, 4], prodKey: 'xA', prodField: F.xA, prodExpo: F.xMin },
  goals: { field: F.goals, expo: F.min, positions: [2, 3, 4], prodKey: 'xG', prodField: F.xG, prodExpo: F.xMin },
  bps: { field: F.bps, expo: F.min, positions: [1, 2, 3, 4], prodKey: 'bps', prodField: F.bps, prodExpo: F.min },
  bonus: { field: F.bonus, expo: F.min, positions: [1, 2, 3, 4], prodKey: null, prodField: null, prodExpo: null },
  saves: { field: F.saves, expo: F.min, positions: [1], prodKey: 'saves', prodField: F.saves, prodExpo: F.min },
  defCon: { field: F.defCon, expo: F.dcMin, positions: [2, 3, 4], prodKey: 'defCon', prodField: F.defCon, prodExpo: F.dcMin },
  yellow: { field: F.yellow, expo: F.min, positions: [1, 2, 3, 4], prodKey: 'yellow', prodField: F.yellow, prodExpo: F.min },
};

const KC = [0.5, 1, 2, 3, 5, 8, 12, 19, 30, 50, 80, 120, 200];
const K0 = [0, 2, 5, 10, 20, 40, 80];
const KNEW = [0.5, 1, 2, 3, 5, 8, 12, 19, 30, 50, 80, 120, 200, 400];
const W = [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.7, 1];

const r4 = (v) => (Number.isFinite(v) ? Math.round(v * 10000) / 10000 : v);
const pct = (v) => `${(100 * v).toFixed(2)}%`;

function dev(y, rate, n) {
  const mu = Math.max(rate, 1e-9) * n;
  const yy = y > 0 ? y : 0;
  if (yy === 0) return 2 * mu;
  return 2 * (yy * Math.log(yy / mu) - yy + mu);
}

// ---------------------------------------------------------------------------
// Season index
// ---------------------------------------------------------------------------

function rowVector(r, position) {
  const v = new Float64Array(NF);
  v[F.min] = r.minutes;
  v[F.xMin] = r.hasExpectedData === false ? 0 : r.minutes;
  v[F.dcMin] = r.hasDefConData === false ? 0 : r.minutes;
  v[F.xG] = r.hasExpectedData === false ? 0 : r.xG;
  v[F.xA] = r.hasExpectedData === false ? 0 : r.xA;
  v[F.assists] = r.assists;
  v[F.goals] = r.goalsScored;
  v[F.bps] = r.bps;
  v[F.bonus] = r.bonus;
  v[F.saves] = r.saves;
  const cbit = r.cbit || 0;
  const rec = r.recoveries || 0;
  const tck = r.tackles || 0;
  v[F.defCon] = r.hasDefConData === false ? 0
    : position === 2 ? cbit + tck
      : position === 3 || position === 4 ? cbit + rec + tck : 0;
  v[F.yellow] = r.yellowCards;
  return v;
}

function setPieceTraits(season) {
  const file = identityPath(season);
  const out = new Map();
  if (!fs.existsSync(file)) return out;
  const { header, rows } = parseCsv(fs.readFileSync(file, 'utf8'));
  const idx = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
  for (const r of rows) {
    const code = Number(r[idx.code]);
    if (!Number.isFinite(code)) continue;
    const ord = (key) => {
      const v = Number(r[idx[key]]);
      return Number.isFinite(v) && v > 0 ? v : null;
    };
    out.set(code, {
      pen: ord('penalties_order'),
      corner: ord('corners_and_indirect_freekicks_order'),
      fk: ord('direct_freekicks_order'),
    });
  }
  return out;
}

function indexSeason(season) {
  const ds = loadSeason(season);
  const players = [];
  for (const p of ds.players.values()) {
    const rows = p.rows.slice().sort((a, b) => a.gw - b.gw || a.fixtureId - b.fixtureId);
    const n = rows.length;
    const pre = new Float64Array((n + 1) * NF);
    const vecs = [];
    const gws = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      const v = rowVector(rows[i], p.position);
      vecs.push(v);
      gws[i] = rows[i].gw;
      for (let j = 0; j < NF; j++) pre[(i + 1) * NF + j] = pre[i * NF + j] + v[j];
    }
    players.push({ id: p.id, code: p.code, position: p.position, teamId: p.teamId, rows, vecs, pre, gws, n });
  }
  // The fewest matches any club has played before each deadline: the
  // production baseline retires once this reaches three.
  const clubsMin = new Int16Array(ds.maxGw + 2);
  const clubs = new Set();
  for (const f of ds.fixtures) { if (f.teamH) clubs.add(f.teamH); if (f.teamA) clubs.add(f.teamA); }
  for (let g = 1; g <= ds.maxGw + 1; g++) {
    const played = new Map([...clubs].map(c => [c, 0]));
    for (const f of ds.fixtures) {
      if (f.event === null || f.event === undefined || f.event >= g) continue;
      played.set(f.teamH, played.get(f.teamH) + 1);
      played.set(f.teamA, played.get(f.teamA) + 1);
    }
    clubsMin[g] = Math.min(...played.values());
  }
  const totalsByCode = new Map();
  for (const p of players) {
    if (p.code === null || p.code === undefined) continue;
    const tot = new Float64Array(NF);
    for (let j = 0; j < NF; j++) tot[j] = p.pre[p.n * NF + j];
    totalsByCode.set(p.code, { position: p.position, tot });
  }
  return { season, ds, players, maxGw: ds.maxGw, clubsMin, totalsByCode, traits: setPieceTraits(season) };
}

const prefixAt = (p, i, j) => p.pre[i * NF + j];
function countBefore(p, g) {
  let lo = 0;
  let hi = p.n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (p.gws[mid] < g) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// ---------------------------------------------------------------------------
// Observation building
// ---------------------------------------------------------------------------

function buildObservations(target, prior) {
  // Previous-season pools per position (players with minutes).
  const lastPool = new Map();
  for (const { position, tot } of prior.totalsByCode.values()) {
    if (!(tot[F.min] > 0)) continue;
    if (!lastPool.has(position)) lastPool.set(position, new Float64Array(NF));
    const acc = lastPool.get(position);
    for (let j = 0; j < NF; j++) acc[j] += tot[j];
  }

  const obs = [];
  for (let g = 1; g <= target.maxGw; g++) {
    const superseded = target.clubsMin[g] >= BASELINE_RETIRE_MATCHES;
    // Pools at this deadline: this season's own, and production's evidence
    // (blended with last season for returners until the baseline retires).
    const curPool = new Map();
    const prodPool = new Map();
    const perPlayer = [];
    for (const p of target.players) {
      const i0 = countBefore(p, g);
      const cur = new Float64Array(NF);
      for (let j = 0; j < NF; j++) cur[j] = prefixAt(p, i0, j);
      const lastRec = p.code !== null && p.code !== undefined ? prior.totalsByCode.get(p.code) : null;
      const last = lastRec && lastRec.tot[F.min] > 0 ? lastRec.tot : null;
      // Production: at gameweek 1 the payload IS last season's totals; before
      // retirement the baseline overlays last + current; after, current only.
      let prod;
      if (g === 1) prod = last ? last.slice() : cur.slice();
      else if (!superseded && last) { prod = new Float64Array(NF); for (let j = 0; j < NF; j++) prod[j] = last[j] + cur[j]; }
      else prod = cur;
      perPlayer.push({ p, i0, cur, last, prod });
      if (!curPool.has(p.position)) { curPool.set(p.position, new Float64Array(NF)); prodPool.set(p.position, new Float64Array(NF)); }
      if (cur[F.min] > 0) { const a = curPool.get(p.position); for (let j = 0; j < NF; j++) a[j] += cur[j]; }
      if (prod[F.min] > 0) { const a = prodPool.get(p.position); for (let j = 0; j < NF; j++) a[j] += prod[j]; }
    }

    // Production bonus curve at this deadline.
    const bx = [];
    const by = [];
    for (const { prod } of perPlayer) {
      if (prod[F.min] < BONUS_MIN_MINUTES) continue;
      const n90 = prod[F.min] / 90;
      bx.push(prod[F.bps] / n90);
      by.push(prod[F.bonus] / n90);
    }
    const prodCurve = bx.length >= BONUS_BINS * 3 ? calibrate(bx, by, 'bins', { bins: BONUS_BINS }) : null;

    for (const { p, i0, cur, last, prod } of perPlayer) {
      // Target: next five appearances from this deadline.
      const fut = new Float64Array(NF);
      let apps = 0;
      let first = null;
      for (let i = i0; i < p.n && apps < NEXT_APPEARANCES; i++) {
        if (!(p.vecs[i][F.min] > 0)) continue;
        if (first === null) first = p.vecs[i];
        for (let j = 0; j < NF; j++) fut[j] += p.vecs[i][j];
        apps++;
      }
      if (!apps) continue;
      const lp = lastPool.get(p.position);
      const cp = curPool.get(p.position);
      const pp = prodPool.get(p.position);
      obs.push({
        season: target.season, g, id: p.id, code: p.code, position: p.position, superseded, seasonGws: prior.maxGw,
        cur, last, prod, fut, first, lp, cp, pp, prodCurve,
        traits: p.code !== null ? target.traits.get(p.code) || null : null,
      });
    }
  }
  return obs;
}

// Per-quantity scalar view of an observation.
function view(o, q) {
  const Q = QUANTITIES[q];
  const yN = o.fut[Q.expo] / 90;
  if (!(yN > 0)) return null;
  const lastN = o.last ? o.last[Q.expo] / 90 : 0;
  const lastPoolN = o.lp ? o.lp[Q.expo] / 90 : 0;
  const lastRate = lastPoolN > 0 ? o.lp[Q.field] / lastPoolN : null;
  const curPoolN = o.cp[Q.expo] / 90;
  const anchor = (lastPoolN / o.seasonGws) * POOL_ANCHOR_GAMEWEEKS;
  const posNow = lastRate === null
    ? (curPoolN > 0 ? o.cp[Q.field] / curPoolN : 0)
    : (o.cp[Q.field] + lastRate * anchor) / (curPoolN + anchor);
  const v = {
    season: o.season, g: o.g, position: o.position, o,
    y: o.fut[Q.field], yN,
    curT: o.cur[Q.field], curN: o.cur[Q.expo] / 90,
    returner: lastN > 0 && lastRate !== null,
    lastT: o.last ? o.last[Q.field] : 0, lastN,
    posLast: lastRate === null ? posNow : lastRate,
    posNow,
    scale: lastRate > 0 ? posNow / lastRate : 1,
  };
  if (Q.prodField !== null) {
    const kProd = priorNinetiesFor(Q.prodKey, o.position);
    const prodN = o.prod[Q.prodExpo] / 90;
    const ppN = o.pp[Q.prodExpo] / 90;
    const prodPos = ppN > 0 ? o.pp[Q.prodField] / ppN : 0;
    v.prodRate = (o.prod[Q.prodField] + prodPos * kProd) / (prodN + kProd);
  }
  return v;
}

const predB = (v, kc, k0, cap, kNew, scaled = false) => {
  if (!v.returner) return (v.curT + v.posNow * kNew) / (v.curN + kNew);
  const prior = ((v.lastT + v.posLast * k0) / (v.lastN + k0 || 1e-9)) * (scaled ? v.scale : 1);
  const k = cap ? Math.min(kc, v.lastN + k0) : kc;
  return (v.curT + prior * k) / (v.curN + k);
};
const predC = (v, w, k, kNew, scaled = false) => {
  if (!v.returner) return (v.curT + v.posNow * kNew) / (v.curN + kNew);
  return (v.curT + w * v.lastT * (scaled ? v.scale : 1) + v.posNow * k) / (v.curN + w * v.lastN + k);
};

// ---------------------------------------------------------------------------
// Fitting
// ---------------------------------------------------------------------------

function seasonDevs(views, predict) {
  const out = Object.fromEntries(TARGETS.map(s => [s, 0]));
  for (const v of views) out[v.season] += dev(v.y, predict(v), v.yN);
  return out;
}

function argminLoso(table, heldOut) {
  // table: [{ params, devs: {season: d} }]; fit on the other target seasons.
  let best = null;
  for (const row of table) {
    let d = 0;
    let used = 0;
    for (const s of TARGETS) {
      if (s === heldOut) continue;
      if (!(s in row.devs)) continue;
      d += row.devs[s];
      used++;
    }
    if (!used) d = row.devs[heldOut];      // single-season quantity: in sample
    if (!best || d < best.d) best = { params: row.params, d };
  }
  return best.params;
}

function argminSingle(table, season) {
  let best = null;
  for (const row of table) if (!best || row.devs[season] < best.d) best = { params: row.params, d: row.devs[season] };
  return best.params;
}

function fitQuantity(q, allViews, position) {
  const views = allViews.filter(v => v.position === position);
  const seasonsPresent = TARGETS.filter(s => views.some(v => v.season === s));
  const ret = views.filter(v => v.returner);
  const fresh = views.filter(v => !v.returner);

  const tableNew = KNEW.map(k => ({ params: { kNew: k }, devs: seasonDevs(fresh, v => predB(v, 0, 0, false, k)) }));
  const tableB = [];
  const tableBs = [];
  for (const kc of KC) for (const k0 of K0) for (const cap of [false, true]) {
    tableB.push({ params: { kc, k0, cap }, devs: seasonDevs(ret, v => predB(v, kc, k0, cap, 0)) });
    tableBs.push({ params: { kc, k0, cap }, devs: seasonDevs(ret, v => predB(v, kc, k0, cap, 0, true)) });
  }
  const tableC = [];
  const tableCs = [];
  for (const w of W) for (const k of KC) {
    tableC.push({ params: { w, k }, devs: seasonDevs(ret, v => predC(v, w, k, 0)) });
    tableCs.push({ params: { w, k }, devs: seasonDevs(ret, v => predC(v, w, k, 0, true)) });
  }

  const folds = {};
  const perSeason = {};
  for (const s of TARGETS) {
    if (!views.some(v => v.season === s)) continue;
    const onlyOne = seasonsPresent.length <= 1;
    const pick = (table) => (onlyOne ? argminSingle(table, s) : argminLoso(table, s));
    folds[s] = { ...pick(tableNew), b: pick(tableB), c: pick(tableC), bs: pick(tableBs), cs: pick(tableCs) };
    perSeason[s] = { kNew: argminSingle(tableNew, s).kNew, b: argminSingle(tableB, s), c: argminSingle(tableC, s), cs: argminSingle(tableCs, s) };
  }
  const pooled = (table) => {
    let best = null;
    for (const row of table) {
      const d = Object.values(row.devs).reduce((a, b) => a + b, 0);
      if (!best || d < best.d) best = { params: row.params, d };
    }
    return best.params;
  };
  const all = { kNew: pooled(tableNew).kNew, b: pooled(tableB), c: pooled(tableC), bs: pooled(tableBs), cs: pooled(tableCs) };
  return { position, folds, perSeason, pooled: all, seasonsPresent };
}

// Held-out predictions for one view under a fitted fold.
function predictFold(v, fold, which) {
  if (which === 'b') return predB(v, fold.b.kc, fold.b.k0, fold.b.cap, fold.kNew);
  if (which === 'bs') return predB(v, fold.bs.kc, fold.bs.k0, fold.bs.cap, fold.kNew, true);
  if (which === 'cs') return predC(v, fold.cs.w, fold.cs.k, fold.kNew, true);
  return predC(v, fold.c.w, fold.c.k, fold.kNew);
}
const MODELS = ['b', 'c', 'bs', 'cs'];

function evaluate(q, views, fits, prodPredict) {
  const zero = () => ({ a: 0, nul: 0, b: 0, c: 0, bs: 0, cs: 0 });
  const bySeason = {};
  const totals = zero();
  const early = zero();
  const withPred = [];
  for (const v of views) {
    const fit = fits[v.position];
    if (!fit || !fit.folds[v.season]) continue;
    const fold = fit.folds[v.season];
    const preds = { a: prodPredict(v), nul: v.posNow };
    for (const m of MODELS) preds[m] = predictFold(v, fold, m);
    const s = (bySeason[v.season] ||= zero());
    for (const k of Object.keys(preds)) {
      const d = dev(v.y, preds[k], v.yN);
      s[k] += d; totals[k] += d;
      if (v.g >= EARLY[0] && v.g <= EARLY[1]) early[k] += d;
    }
    withPred.push({ v, preds });
  }
  const recKey = MODELS.reduce((best, m) => (totals[m] < totals[best] ? m : best), 'c');
  // Top decile within (season, g, position), ranked by a NEUTRAL ordering (the
  // geometric mean of production and the recommendation) so neither model is
  // graded on the players its own errors selected.
  const groups = new Map();
  for (const r of withPred) {
    const key = `${r.v.season}|${r.v.g}|${r.v.position}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const top = { y: 0, a: 0, rec: 0, devA: 0, devRec: 0, byModel: Object.fromEntries(MODELS.map(m => [m, 0])) };
  const earlyTop = { y: 0, a: 0, rec: 0 };
  for (const list of groups.values()) {
    const key = (r) => Math.sqrt(Math.max(r.preds.a, 1e-9) * Math.max(r.preds[recKey], 1e-9));
    list.sort((x, y) => key(y) - key(x));
    const n = Math.max(1, Math.floor(list.length / 10));
    for (const r of list.slice(0, n)) {
      top.y += r.v.y; top.a += r.preds.a * r.v.yN; top.rec += r.preds[recKey] * r.v.yN;
      for (const m of MODELS) top.byModel[m] += r.preds[m] * r.v.yN;
      top.devA += dev(r.v.y, r.preds.a, r.v.yN); top.devRec += dev(r.v.y, r.preds[recKey], r.v.yN);
      if (r.v.g >= EARLY[0] && r.v.g <= EARLY[1]) { earlyTop.y += r.v.y; earlyTop.a += r.preds.a * r.v.yN; earlyTop.rec += r.preds[recKey] * r.v.yN; }
    }
  }
  const d2 = (x, t = totals) => 1 - t[x] / t.nul;
  const gain = (x, t = totals) => (t.a - t[x]) / t.a;
  return {
    quantity: q,
    recommended: recKey,
    heldOut: {
      deviance: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, r4(v)])),
      D2: Object.fromEntries(['a', ...MODELS].map(m => [m, r4(d2(m))])),
      gainVsProduction: Object.fromEntries(MODELS.map(m => [m, r4(gain(m))])),
      early: { ...Object.fromEntries(MODELS.map(m => [`gain_${m}`, r4(gain(m, early))])), D2a: r4(d2('a', early)), D2rec: r4(d2(recKey, early)) },
      bySeason: Object.fromEntries(Object.entries(bySeason).map(([s, x]) => [s, Object.fromEntries(MODELS.map(m => [m, r4((x.a - x[m]) / x.a)]))])),
      topDecile: {
        observedOverPredicted: { a: r4(top.y / top.a), rec: r4(top.y / top.rec), ...Object.fromEntries(MODELS.map(m => [m, r4(top.y / top.byModel[m])])) },
        devianceGain: r4((top.devA - top.devRec) / top.devA),
        earlyObservedOverPredicted: { a: r4(earlyTop.y / earlyTop.a), rec: r4(earlyTop.y / earlyTop.rec) },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Assists
// ---------------------------------------------------------------------------

// Poisson regression with an offset, by Newton's method. X rows exclude the
// intercept column (added here). Small feature counts only.
function poissonOffsetFit(X, y, offset, { lambda = 1e-4, iters = 50 } = {}) {
  const p = X[0].length + 1;
  const beta = new Float64Array(p);
  for (let it = 0; it < iters; it++) {
    const g = new Float64Array(p);
    const H = Array.from({ length: p }, () => new Float64Array(p));
    for (let i = 0; i < X.length; i++) {
      const row = [1, ...X[i]];
      let eta = offset[i];
      for (let j = 0; j < p; j++) eta += beta[j] * row[j];
      const mu = Math.exp(Math.min(20, Math.max(-20, eta)));
      for (let j = 0; j < p; j++) {
        g[j] += (y[i] - mu) * row[j];
        for (let k = 0; k < p; k++) H[j][k] += mu * row[j] * row[k];
      }
    }
    for (let j = 1; j < p; j++) { g[j] -= lambda * beta[j]; H[j][j] += lambda; }
    const step = solve(H, g);
    let maxStep = 0;
    for (let j = 0; j < p; j++) { beta[j] += step[j]; maxStep = Math.max(maxStep, Math.abs(step[j])); }
    if (maxStep < 1e-8) break;
  }
  return Array.from(beta);
}

function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-12));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const t0 = Date.now();
  const seasons = new Map(ALL_SEASONS.map(s => [s, indexSeason(s)]));
  console.log(`loaded ${ALL_SEASONS.join(', ')} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const obs = [];
  for (const s of TARGETS) {
    const prevName = ALL_SEASONS[ALL_SEASONS.indexOf(s) - 1];
    obs.push(...buildObservations(seasons.get(s), seasons.get(prevName)));
  }
  console.log(`observations: ${obs.length}`);

  const out = { generatedAt: new Date().toISOString(), targets: TARGETS, nextAppearances: NEXT_APPEARANCES, quantities: {} };

  // ---- Part 1: rate shrinkage ------------------------------------------------
  const fitsByQ = {};
  const viewsByQ = {};
  console.log('\nPART 1: held-out Poisson deviance of the next-5-appearance count');
  console.log('quantity pos  | gain b   c        bs       cs     | early rec | D2 a  D2 rec   | top10% obs/pred a rec | early top a rec | by-season gain rec | fitted rec (pooled)');
  for (const q of Object.keys(QUANTITIES)) {
    const Q = QUANTITIES[q];
    const views = [];
    for (const o of obs) {
      if (!Q.positions.includes(o.position)) continue;
      const v = view(o, q);
      if (v) views.push(v);
    }
    viewsByQ[q] = views;
    const fits = {};
    for (const pos of Q.positions) fits[pos] = fitQuantity(q, views, pos);
    fitsByQ[q] = fits;
    out.quantities[q] = { positions: {} };
    // Production predictor for this quantity (bonus: the production curve on
    // the production BPS rate).
    const bpsProd = (v) => view(v.o, 'bps').prodRate;
    const prodPredict = q === 'bonus'
      ? (v) => {
        const b = bpsProd(v);
        const c = v.o.prodCurve;
        return Math.min(MAX_BONUS, c ? Math.max(0, c.predict(b)) : BONUS_FALLBACK(b));
      }
      : (v) => v.prodRate;
    for (const pos of Q.positions) {
      const ev = evaluate(q, views.filter(v => v.position === pos), fits, prodPredict);
      out.quantities[q].positions[POSITION_NAMES[pos]] = { fit: fits[pos], evaluation: ev };
      const h = ev.heldOut;
      const pooled = fits[pos].pooled;
      const rec = ev.recommended;
      const fitted = rec.startsWith('b')
        ? `kc ${pooled[rec].kc} k0 ${pooled[rec].k0}${pooled[rec].cap ? ' cap' : ''}`
        : `w ${pooled[rec].w} k ${pooled[rec].k}`;
      console.log(
        `${q.padEnd(8)} ${POSITION_NAMES[pos].padEnd(4)} | ${MODELS.map(m => pct(h.gainVsProduction[m]).padStart(7)).join(' ')} | `
        + `${pct(h.early[`gain_${rec}`]).padStart(7)} | ${h.D2.a.toFixed(3)} ${h.D2[rec].toFixed(3)}(${rec}) | `
        + `${h.topDecile.observedOverPredicted.a.toFixed(3)} ${h.topDecile.observedOverPredicted.rec.toFixed(3)} | `
        + `${h.topDecile.earlyObservedOverPredicted.a.toFixed(3)} ${h.topDecile.earlyObservedOverPredicted.rec.toFixed(3)} | `
        + `${Object.values(h.bySeason).map(x => pct(x[rec])).join(' ')} | ${rec}: ${fitted}; kNew ${pooled.kNew}`,
      );
    }
  }

  console.log('\ntop decile observed/predicted under the neutral ranking, every model');
  for (const q of Object.keys(QUANTITIES)) {
    for (const pos of QUANTITIES[q].positions) {
      const t = out.quantities[q].positions[POSITION_NAMES[pos]].evaluation.heldOut.topDecile.observedOverPredicted;
      console.log(`${q.padEnd(8)} ${POSITION_NAMES[pos].padEnd(4)} a ${t.a} b ${t.b} c ${t.c} bs ${t.bs} cs ${t.cs}`);
    }
  }

  // Stability of the optimum across seasons.
  console.log('\nper-season optima (c: w/k, kNew)');
  for (const q of Object.keys(QUANTITIES)) {
    for (const pos of QUANTITIES[q].positions) {
      const ps = fitsByQ[q][pos].perSeason;
      console.log(`${q.padEnd(8)} ${POSITION_NAMES[pos].padEnd(4)} ` + Object.entries(ps).map(([s, x]) => `${s}: cs w ${x.cs.w} k ${x.cs.k}; c w ${x.c.w} k ${x.c.k}; kNew ${x.kNew}`).join(' | '));
    }
  }

  // Recommended rate for a view, from its fold.
  const recRate = (q, v) => {
    const fit = fitsByQ[q][v.position];
    if (!fit || !fit.folds[v.season]) return v.posNow;
    const which = out.quantities[q].positions[POSITION_NAMES[v.position]].evaluation.recommended;
    return predictFold(v, fit.folds[v.season], which);
  };

  // ---- Part 2: assists ---------------------------------------------------------
  console.log('\nPART 2: FPL assists');
  // Descriptive: player-season aggregates over covered rows.
  const desc = { byPosition: {}, byXaQuartile: {}, byXgQuartile: {}, bySetPiece: {} };
  const ps = [];
  for (const s of ALL_SEASONS) {
    const idx = seasons.get(s);
    for (const p of idx.players) {
      let xMin = 0; let xa = 0; let as = 0; let xg = 0;
      for (const v of p.vecs) {
        if (!(v[F.xMin] > 0)) continue;
        xMin += v[F.xMin]; xa += v[F.xA]; as += v[F.assists]; xg += v[F.xG];
      }
      if (xMin < 900) continue;
      ps.push({ season: s, position: p.position, xa, as, xg, n90: xMin / 90, traits: p.code !== null ? idx.traits.get(p.code) : null });
    }
  }
  const ratio = (list) => { const a = list.reduce((t, r) => t + r.as, 0); const x = list.reduce((t, r) => t + r.xa, 0); return { ratio: r4(a / x), assists: a, xA: r4(x), players: list.length }; };
  for (const pos of [1, 2, 3, 4]) desc.byPosition[POSITION_NAMES[pos]] = ratio(ps.filter(r => r.position === pos));
  const outfield = ps.filter(r => r.position !== 1);
  const quartiles = (list, key) => {
    const sorted = [...list].sort((a, b) => a[key] / a.n90 - b[key] / b.n90);
    const q4 = Math.floor(sorted.length / 4);
    return [0, 1, 2, 3].map(i => sorted.slice(i * q4, i === 3 ? sorted.length : (i + 1) * q4));
  };
  quartiles(outfield, 'xa').forEach((list, i) => { desc.byXaQuartile[`Q${i + 1}`] = { ...ratio(list), xa90: r4(list.reduce((t, r) => t + r.xa, 0) / list.reduce((t, r) => t + r.n90, 0)) }; });
  quartiles(outfield, 'xg').forEach((list, i) => { desc.byXgQuartile[`Q${i + 1}`] = { ...ratio(list), xg90: r4(list.reduce((t, r) => t + r.xg, 0) / list.reduce((t, r) => t + r.n90, 0)) }; });
  desc.bySetPiece.cornerTaker = ratio(outfield.filter(r => r.traits && r.traits.corner === 1));
  desc.bySetPiece.notCornerTaker = ratio(outfield.filter(r => !(r.traits && r.traits.corner === 1)));
  desc.bySetPiece.penaltyTaker = ratio(outfield.filter(r => r.traits && r.traits.pen === 1));
  desc.bySetPiece.freeKickTaker = ratio(outfield.filter(r => r.traits && r.traits.fk === 1));
  console.log('ratio FPL assists / xA, player-seasons with 900+ covered minutes:');
  console.log(' by position', JSON.stringify(desc.byPosition));
  console.log(' by xA/90 quartile (outfield)', JSON.stringify(desc.byXaQuartile));
  console.log(' by xG/90 quartile (outfield)', JSON.stringify(desc.byXgQuartile));
  console.log(' by set piece (end-of-season snapshot, descriptive only)', JSON.stringify(desc.bySetPiece));

  // Predictive models on the next-5 assist count, outfield.
  const aViews = viewsByQ.assists;
  const xaView = new Map(viewsByQ.xA.map(v => [v.o, v]));
  const xgView = new Map(viewsByQ.xG.map(v => [v.o, v]));
  const rows = [];
  for (const v of aViews) {
    const vx = xaView.get(v.o);
    const vg = xgView.get(v.o);
    if (!vx || !vg) continue;
    rows.push({
      v, season: v.season, position: v.position, g: v.g, y: v.y, n: v.yN,
      xaRec: Math.max(1e-6, recRate('xA', vx)), xgRec: Math.max(1e-6, recRate('xG', vg)),
      xaProd: Math.max(1e-6, vx.prodRate),
      aRec: Math.max(0, recRate('assists', v)),
      posXa: Math.max(1e-6, vx.posNow), posXg: Math.max(1e-6, vg.posNow),
    });
  }
  const models = {};
  const heldOutDev = (name, predict) => {
    const res = { total: 0, early: 0, bySeason: {} };
    for (const r of rows) {
      const d = dev(r.y, predict(r), r.n);
      res.total += d;
      if (r.g >= EARLY[0] && r.g <= EARLY[1]) res.early += d;
      res.bySeason[r.season] = (res.bySeason[r.season] || 0) + d;
    }
    models[name] = res;
    return res;
  };
  // Fold-fitted pieces.
  const posRatio = {};
  for (const s of TARGETS) {
    posRatio[s] = {};
    for (const pos of [2, 3, 4]) {
      const train = rows.filter(r => r.season !== s && r.position === pos);
      posRatio[s][pos] = train.reduce((t, r) => t + r.y, 0) / train.reduce((t, r) => t + r.xaRec * r.n, 0);
    }
  }
  heldOutDev('M0 raw xA (production rate)', r => r.xaProd);
  heldOutDev('M0b raw xA (player-prior rate)', r => r.xaRec);
  heldOutDev('M1 xA x position ratio', r => r.xaRec * posRatio[r.season][r.position]);

  // M2: log-linear conversion conditioned on xA and xG level.
  const feat = (r) => [
    r.position === 2 ? 1 : 0, r.position === 4 ? 1 : 0,
    Math.log(r.xaRec / r.posXa), Math.log((r.xgRec + 0.01) / (r.posXg + 0.01)),
  ];
  const m2Coef = {};
  for (const s of TARGETS) {
    const train = rows.filter(r => r.season !== s);
    m2Coef[s] = poissonOffsetFit(train.map(feat), train.map(r => r.y), train.map(r => Math.log(r.xaRec * r.n)));
  }
  const m2 = (r) => {
    const b = m2Coef[r.season];
    const f = feat(r);
    let eta = b[0];
    for (let j = 0; j < f.length; j++) eta += b[j + 1] * f[j];
    return r.xaRec * Math.exp(eta);
  };
  for (const r of rows) r.m2 = m2(r);
  heldOutDev('M2 xA x exp(pos + a*log(xA/pos) + b*log(xG/pos))', r => r.m2);
  const allCoef = poissonOffsetFit(rows.map(feat), rows.map(r => r.y), rows.map(r => Math.log(r.xaRec * r.n)));

  // M3: blend own shrunk FPL-assist rate with the ratio-scaled xA rate.
  const blendW = {};
  for (const s of TARGETS) {
    let best = null;
    for (let w = 0; w <= 1.0001; w += 0.05) {
      let d = 0;
      for (const r of rows) if (r.season !== s) d += dev(r.y, w * r.aRec + (1 - w) * r.m2, r.n);
      if (!best || d < best.d) best = { w: r4(w), d };
    }
    blendW[s] = best.w;
  }
  heldOutDev('M3 blend own FPL-assist rate with M2', r => blendW[r.season] * r.aRec + (1 - blendW[r.season]) * r.m2);

  // M4: empirical Bayes on FPL assists with the M2 rate as the prior mean.
  const m4Grid = [];
  for (const wl of [0, 0.1, 0.25, 0.5, 1]) for (const kA of KC) m4Grid.push({ wl, kA });
  const m4Pred = (r, { wl, kA }) => {
    const v = r.v;
    return (v.curT + wl * v.lastT + kA * r.m2) / (v.curN + wl * v.lastN + kA);
  };
  const m4Table = m4Grid.map(prm => {
    const devs = Object.fromEntries(TARGETS.map(s => [s, 0]));
    for (const r of rows) devs[r.season] += dev(r.y, m4Pred(r, prm), r.n);
    return { params: prm, devs };
  });
  const m4Fit = Object.fromEntries(TARGETS.map(s => [s, argminLoso(m4Table, s)]));
  heldOutDev('M4 EB: own FPL assists over an M2 prior', r => m4Pred(r, m4Fit[r.season]));

  const base = models['M0 raw xA (production rate)'];
  console.log('held-out deviance, next-5 FPL assists (outfield): model | gain vs production | early gain | per season gains');
  for (const [name, res] of Object.entries(models)) {
    console.log(` ${name.padEnd(52)} ${pct((base.total - res.total) / base.total).padStart(7)} ${pct((base.early - res.early) / base.early).padStart(7)} `
      + TARGETS.map(s => pct((base.bySeason[s] - res.bySeason[s]) / base.bySeason[s])).join(' '));
  }

  // The registry 12 failure mode: calibration of creators versus finishers.
  const groupCal = (predict) => {
    const out2 = {};
    for (const pos of [3, 4]) {
      const list = rows.filter(r => r.position === pos);
      const byXa = [...list].sort((a, b) => a.xaRec - b.xaRec);
      const byXg = [...list].sort((a, b) => a.xgRec - b.xgRec);
      const topXa = byXa.slice(Math.floor(byXa.length * 0.75));
      const xaMedian = byXa[Math.floor(byXa.length / 2)].xaRec;
      const finishers = byXg.slice(Math.floor(byXg.length * 0.75)).filter(r => r.xaRec < xaMedian);
      const cal = (set) => r4(set.reduce((t, r) => t + r.y, 0) / set.reduce((t, r) => t + predict(r) * r.n, 0));
      out2[POSITION_NAMES[pos]] = { eliteCreators: cal(topXa), finishersLowXa: cal(finishers), all: cal(list) };
    }
    return out2;
  };
  const calibrations = {
    M0: groupCal(r => r.xaRec),
    M1: groupCal(r => r.xaRec * posRatio[r.season][r.position]),
    M2: groupCal(m2),
    M4: groupCal(r => m4Pred(r, m4Fit[r.season])),
  };
  console.log('observed/predicted assists by group (held out):', JSON.stringify(calibrations));
  console.log('M2 coefficients (all seasons): [intercept, DEF, FWD, log xA/pos, log xG/pos] =', allCoef.map(r4).join(', '));
  console.log('M2 fold coefficients', JSON.stringify(Object.fromEntries(Object.entries(m2Coef).map(([s, b]) => [s, b.map(r4)]))));
  console.log('position ratios by fold', JSON.stringify(Object.fromEntries(Object.entries(posRatio).map(([s, x]) => [s, Object.fromEntries(Object.entries(x).map(([p, v]) => [POSITION_NAMES[p], r4(v)]))]))));
  console.log('M3 blend weights by fold', JSON.stringify(blendW), 'M4 fits by fold', JSON.stringify(m4Fit));
  out.assists = {
    descriptive: desc,
    heldOut: Object.fromEntries(Object.entries(models).map(([k, v]) => [k, {
      gainVsProduction: r4((base.total - v.total) / base.total), earlyGain: r4((base.early - v.early) / base.early),
      bySeasonGain: Object.fromEntries(TARGETS.map(s => [s, r4((base.bySeason[s] - v.bySeason[s]) / base.bySeason[s])])),
    }])),
    calibrationByGroup: calibrations,
    m2: { features: ['intercept', 'isDEF', 'isFWD', 'log(xA/posMeanXA)', 'log((xG+0.01)/(posMeanXG+0.01))'], allSeasons: allCoef.map(r4), folds: Object.fromEntries(Object.entries(m2Coef).map(([s, b]) => [s, b.map(r4)])) },
    positionRatios: posRatio, m3BlendWeights: blendW, m4Fits: m4Fit,
  };

  // ---- Part 3: bonus -------------------------------------------------------------
  console.log('\nPART 3: bonus');
  const bonusViews = viewsByQ.bonus;
  const bpsByObs = new Map(viewsByQ.bps.map(v => [v.o, v]));
  // Previous-season curve for each target season.
  const lastCurves = {};
  for (const s of TARGETS) {
    const prev = seasons.get(ALL_SEASONS[ALL_SEASONS.indexOf(s) - 1]);
    const x = []; const yb = [];
    for (const { tot } of prev.totalsByCode.values()) {
      if (tot[F.min] < BONUS_MIN_MINUTES) continue;
      const n90 = tot[F.min] / 90;
      x.push(tot[F.bps] / n90); yb.push(tot[F.bonus] / n90);
    }
    lastCurves[s] = calibrate(x, yb, 'bins', { bins: BONUS_BINS });
  }
  const bRows = [];
  for (const v of bonusViews) {
    const vb = bpsByObs.get(v.o);
    if (!vb) continue;
    const firstN = v.o.first[F.min] / 90;
    bRows.push({
      v, vb, season: v.season, g: v.g, y5: v.y, n5: v.yN, y1: v.o.first[F.bonus], n1: firstN,
      bpsProd: vb.prodRate, bpsRec: recRate('bps', vb), bonusRec: Math.max(0, recRate('bonus', v)),
      prodCurve: v.o.prodCurve, lastCurve: lastCurves[v.season],
      ownBonus90: v.curN > 0 ? v.curT / v.curN : null, ownN: v.curN,
    });
  }
  const clampB = (x) => Math.min(MAX_BONUS, Math.max(0, x));
  const curveOrFallback = (c, b) => clampB(c ? c.predict(b) : BONUS_FALLBACK(b));
  const bModels = {};
  const bEval = (name, predict) => {
    const res = { d5: 0, d1: 0, e5: 0, e1: 0, bySeason: {} };
    for (const r of bRows) {
      const p = predict(r);
      const d5 = dev(r.y5, p, r.n5);
      const d1 = dev(r.y1, p, r.n1);
      res.d5 += d5; res.d1 += d1;
      if (r.g >= EARLY[0] && r.g <= EARLY[1]) { res.e5 += d5; res.e1 += d1; }
      res.bySeason[r.season] = (res.bySeason[r.season] || 0) + d5;
    }
    bModels[name] = { res, predict };
    return res;
  };
  bEval('B1 production: current curve (or fallback) on production BPS', r => curveOrFallback(r.prodCurve, r.bpsProd));
  bEval('B2 fallback line on production BPS', r => clampB(BONUS_FALLBACK(r.bpsProd)));
  bEval('B3a last-season curve on production BPS', r => clampB(r.lastCurve.predict(r.bpsProd)));
  bEval('B3b last-season curve on player-prior BPS', r => clampB(r.lastCurve.predict(r.bpsRec)));
  bEval('B3c last-season curve on player-prior BPS in last season\'s scale', r => clampB(r.lastCurve.predict(r.bpsRec / r.vb.scale)));
  bEval('B7 current curve (or fallback) on player-prior BPS', r => curveOrFallback(r.prodCurve, r.bpsRec));

  // B4: BPS shrinkage chosen for the BONUS objective, last-season curve.
  const bpsC = (r, w, k, kNew) => predC(r.vb, w, k, kNew, true) / r.vb.scale;
  const b4Table = [];
  for (const w of W) for (const k of KC) for (const kNew of [2, 5, 12, 30]) {
    const devs = Object.fromEntries(TARGETS.map(s => [s, 0]));
    for (const r of bRows) devs[r.season] += dev(r.y5, clampB(r.lastCurve.predict(bpsC(r, w, k, kNew))), r.n5);
    b4Table.push({ params: { w, k, kNew }, devs });
  }
  const b4Fit = Object.fromEntries(TARGETS.map(s => [s, argminLoso(b4Table, s)]));
  const b4 = (r) => { const f = b4Fit[r.season]; return clampB(r.lastCurve.predict(bpsC(r, f.w, f.k, f.kNew))); };
  bEval('B4 last-season curve on BPS shrunk for the bonus objective', b4);

  // B5: blend with the player's own shrunk bonus rate.
  const b5Fit = {};
  for (const s of TARGETS) {
    let best = null;
    for (let w = 0; w <= 1.0001; w += 0.05) {
      let d = 0;
      for (const r of bRows) if (r.season !== s) d += dev(r.y5, w * r.bonusRec + (1 - w) * b4(r), r.n5);
      if (!best || d < best.d) best = { w: r4(w), d };
    }
    b5Fit[s] = best.w;
  }
  const b5 = (r) => b5Fit[r.season] * r.bonusRec + (1 - b5Fit[r.season]) * b4(r);
  bEval('B5 blend: own shrunk bonus rate with B4', b5);
  bEval('B6 own shrunk bonus rate alone (part 1 bonus model)', r => r.bonusRec);
  const b7 = (r) => curveOrFallback(r.prodCurve, r.bpsRec);
  const b8Table = [];
  for (let w = 0; w <= 1.0001; w += 0.05) {
    const devs = Object.fromEntries(TARGETS.map(s => [s, 0]));
    for (const r of bRows) devs[r.season] += dev(r.y5, w * r.bonusRec + (1 - w) * b7(r), r.n5);
    b8Table.push({ params: { w: r4(w) }, devs });
  }
  const b8Fit = Object.fromEntries(TARGETS.map(s => [s, argminLoso(b8Table, s).w]));
  bEval('B8 blend: own shrunk bonus rate with B7 (current curve)', r => b8Fit[r.season] * r.bonusRec + (1 - b8Fit[r.season]) * b7(r));

  const bBase = bModels['B1 production: current curve (or fallback) on production BPS'].res;
  console.log('model | next-5 gain | next-app gain | early next-5 | early next-app | per season next-5');
  for (const [name, { res }] of Object.entries(bModels)) {
    console.log(` ${name.padEnd(62)} ${pct((bBase.d5 - res.d5) / bBase.d5).padStart(7)} ${pct((bBase.d1 - res.d1) / bBase.d1).padStart(7)} ${pct((bBase.e5 - res.e5) / bBase.e5).padStart(7)} ${pct((bBase.e1 - res.e1) / bBase.e1).padStart(7)} `
      + TARGETS.map(s => pct((bBase.bySeason[s] - res.bySeason[s]) / bBase.bySeason[s])).join(' '));
  }
  // Calibration: top decile by the recommended bonus model, and early top own-bonus players.
  const bestBonusName = Object.entries(bModels).sort((a, b) => a[1].res.d5 - b[1].res.d5)[0][0];
  const bestBonus = bModels[bestBonusName].predict;
  const bCal = (set, predict) => r4(set.reduce((t, r) => t + r.y5, 0) / set.reduce((t, r) => t + predict(r) * r.n5, 0));
  const groupsB = new Map();
  for (const r of bRows) {
    const key = `${r.season}|${r.g}`;
    if (!groupsB.has(key)) groupsB.set(key, []);
    groupsB.get(key).push(r);
  }
  const topB = []; const earlyOwnTop = [];
  for (const list of groupsB.values()) {
    const sorted = [...list].sort((a, b) => bestBonus(b) - bestBonus(a));
    topB.push(...sorted.slice(0, Math.max(1, Math.floor(sorted.length / 10))));
    if (list[0].g >= EARLY[0] && list[0].g <= EARLY[1]) {
      const own = list.filter(r => r.ownN >= 1.5).sort((a, b) => b.ownBonus90 - a.ownBonus90);
      earlyOwnTop.push(...own.slice(0, Math.max(1, Math.floor(own.length / 10))));
    }
  }
  const bonusCalibration = {
    topDecileByRecommended: Object.fromEntries(Object.entries(bModels).map(([k, m]) => [k, bCal(topB, m.predict)])),
    earlyTopOwnBonusPlayers: Object.fromEntries(Object.entries(bModels).map(([k, m]) => [k, bCal(earlyOwnTop, m.predict)])),
  };
  console.log(`recommended by held-out next-5 deviance: ${bestBonusName}`);
  console.log('observed/predicted, top decile by recommended:', JSON.stringify(bonusCalibration.topDecileByRecommended));
  console.log('observed/predicted, early (g 2-8) top-decile own bonus/90 players:', JSON.stringify(bonusCalibration.earlyTopOwnBonusPlayers));
  console.log('B4 fits', JSON.stringify(b4Fit), 'B5 weights', JSON.stringify(b5Fit), 'B8 weights', JSON.stringify(b8Fit));
  const allCurve = {};
  for (const s of TARGETS) allCurve[s] = lastCurves[s].toJSON().points.map(p => [r4(p.x), r4(p.y)]);
  out.bonus = {
    heldOut: Object.fromEntries(Object.entries(bModels).map(([k, { res }]) => [k, {
      next5Gain: r4((bBase.d5 - res.d5) / bBase.d5), nextAppGain: r4((bBase.d1 - res.d1) / bBase.d1),
      earlyNext5Gain: r4((bBase.e5 - res.e5) / bBase.e5), earlyNextAppGain: r4((bBase.e1 - res.e1) / bBase.e1),
      bySeasonNext5Gain: Object.fromEntries(TARGETS.map(s => [s, r4((bBase.bySeason[s] - res.bySeason[s]) / bBase.bySeason[s])])),
    }])),
    recommended: bestBonusName, calibration: bonusCalibration, b4Fits: b4Fit, b5Weights: b5Fit, b8Weights: b8Fit, lastSeasonCurves: allCurve,
  };

  // ---- Part 4: goals beyond xG ----------------------------------------------------
  console.log('\nPART 4: do actual goals add to xG?');
  const gRows = [];
  for (const v of viewsByQ.goals) {
    const vg = xgView.get(v.o);
    if (!vg) continue;
    gRows.push({ v, season: v.season, g: v.g, y: v.y, n: v.yN, position: v.position, xg: Math.max(1e-6, recRate('xG', vg)), gl: Math.max(0, recRate('goals', v)) });
  }
  const gRatio = {};
  for (const s of TARGETS) {
    gRatio[s] = {};
    for (const pos of [2, 3, 4]) {
      const train = gRows.filter(r => r.season !== s && r.position === pos);
      gRatio[s][pos] = train.reduce((t, r) => t + r.y, 0) / train.reduce((t, r) => t + r.xg * r.n, 0);
    }
  }
  const gw = {};
  for (const s of TARGETS) {
    let best = null;
    for (let w = 0; w <= 1.0001; w += 0.05) {
      let d = 0;
      for (const r of gRows) if (r.season !== s) d += dev(r.y, w * r.gl + (1 - w) * r.xg * gRatio[s][r.position], r.n);
      if (!best || d < best.d) best = { w: r4(w), d };
    }
    gw[s] = best.w;
  }
  const gDev = (predict) => gRows.reduce((t, r) => t + dev(r.y, predict(r), r.n), 0);
  const dXg = gDev(r => r.xg);
  const dXgRatio = gDev(r => r.xg * gRatio[r.season][r.position]);
  const dBlend = gDev(r => gw[r.season] * r.gl + (1 - gw[r.season]) * r.xg * gRatio[r.season][r.position]);
  const dProd = gDev(r => { const vg = xgView.get(r.v.o); return vg.prodRate; });
  console.log(`held-out gain vs production xG rate: player-prior xG ${pct((dProd - dXg) / dProd)}, x goal/xG ratio ${pct((dProd - dXgRatio) / dProd)}, blend with shrunk goals ${pct((dProd - dBlend) / dProd)}; blend weights on goals by fold ${JSON.stringify(gw)}; goals/xG ratio by fold ${JSON.stringify(Object.fromEntries(Object.entries(gRatio).map(([s, x]) => [s, Object.fromEntries(Object.entries(x).map(([p, v]) => [POSITION_NAMES[p], r4(v)]))])))}`);
  out.goals = { gainPlayerPriorXg: r4((dProd - dXg) / dProd), gainRatioXg: r4((dProd - dXgRatio) / dProd), gainBlendGoals: r4((dProd - dBlend) / dProd), blendWeightsOnGoals: gw, goalOverXgRatio: gRatio };

  out.recommendedRates = {};
  for (const q of Object.keys(QUANTITIES)) {
    out.recommendedRates[q] = {};
    for (const pos of QUANTITIES[q].positions) {
      const name = POSITION_NAMES[pos];
      const ev = out.quantities[q].positions[name].evaluation;
      const fit = fitsByQ[q][pos];
      out.recommendedRates[q][name] = {
        model: ev.recommended, pooled: { kNew: fit.pooled.kNew, ...fit.pooled[ev.recommended] },
        folds: Object.fromEntries(Object.entries(fit.folds).map(([s, f]) => [s, { kNew: f.kNew, ...f[ev.recommended] }])),
        heldOutGain: ev.heldOut.gainVsProduction[ev.recommended], earlyGain: ev.heldOut.early[`gain_${ev.recommended}`],
        topDecileObsOverPred: ev.heldOut.topDecile.observedOverPredicted,
      };
    }
  }
  const outDir = path.join(DATA_DIR, 'calibration');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'rates.json'), JSON.stringify(out, null, 1));
  console.log(`\nwrote ${path.join(outDir, 'rates.json')} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main();
