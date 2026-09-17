#!/usr/bin/env node
// Early-season team strength: which production-observable signals predict the
// next gameweek's goals, and how much each deserves.
//
// WHAT PRODUCTION CAN SEE AT THE DEADLINE OF GAMEWEEK g
//
//   - fixture RESULTS (goals) for matches before g; the fixtures endpoint
//     carries no team xG;
//   - season-to-date PLAYER totals (xG, xGC, minutes) from bootstrap-static,
//     aggregated by each player's CURRENT club (what strength.js already does);
//   - last season's player totals keyed by `code` (data/opening-baseline.json),
//     which can be aggregated by the player's CURRENT club: a squad prior that
//     follows transfers;
//   - FPL's strength_overall tier, which cannot be validated historically (the
//     archive's teams.csv is an end-of-season snapshot on another scale), so it
//     is deliberately not an input here.
//
// Per-fixture team xG (the sum of player xG in a fixture) IS in the archive and
// is NOT visible to production. It is used only for the upper-bound arm E and
// for the secondary error metric, and is labelled as such everywhere.
//
// LEAKAGE. Ratings for gameweek g read only rows and fixtures with gw < g, the
// club each player is registered to for gameweek g (known at the deadline), and
// the complete previous season. Weights are fitted leave-one-season-out over
// 2023-24, 2024-25 and 2025-26; nothing from 2026-27 is fitted. The live GW5
// section at the end applies the full-fit parameters read-only.
//
// ARMS
//   base   league mean goals and home advantage only
//   A      the current engine: buildStrength on the state production builds
//          today (last season's totals pre-season, baseline overlay at weight 1
//          until every club has played 3, then this season only)
//   B      this season's squad xG/xGC per match only, shrunk to the mean
//   C      last season's squad aggregates by current club only
//   C2     last season's CLUB team xG per match (needs a shipped team table;
//          production cannot compute it from the player baseline)
//   D      C + this season's squad xG (pseudo-match blend)
//   G      goals IPF only (flat prior), for reference
//   DG     D + goals IPF with fitted pseudo-matches
//   D2G    D with a prior mixing C and C2 + goals IPF (needs a team table)
//   E      UPPER BOUND, NOT PRODUCTION-COMPUTABLE: C prior + per-fixture xG IPF
//          + goals IPF
//
// Usage:
//   node apps/fpl-planner/scripts/calibration/calibrate-strength.mjs
//   node apps/fpl-planner/scripts/calibration/calibrate-strength.mjs --quick
//   node apps/fpl-planner/scripts/calibration/calibrate-strength.mjs --live <dir with bootstrap.json + fixtures.json>
//
// Writes apps/fpl-planner/.data/calibration/strength.json (gitignored).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSeason, previousSeason } from '../backtest.mjs';
import { DATA_DIR, seasonPath } from '../fetch-history.mjs';
import { buildStrength } from '../../js/engine/strength.js';
import { expectedGoals } from '../../js/engine/fixtures.js';
import { buildGameState } from '../../js/engine/normalize.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(HERE, '..', '..');
const OUT_DIR = path.join(DATA_DIR, 'calibration');
const OUT_FILE = path.join(OUT_DIR, 'strength.json');

const TARGETS = ['2023-24', '2024-25', '2025-26'];
const QUICK = process.argv.includes('--quick');
// A directory holding a live bootstrap.json and fixtures.json to apply the
// full-fit parameters to, read-only (the section at the end). Optional.
const LIVE_DIR = (() => {
  const i = process.argv.indexOf('--live');
  return i > 0 ? process.argv[i + 1] : null;
})();

// Shared across every arm so the arms differ only in their ratings.
const HA_PRIOR = 1.15;
const LEVEL_PRIOR_MATCHES = 40;
const RECENCY_HALF_LIFE_GWS = 10;
const IPF_ITERATIONS = QUICK ? 12 : 25;
const RATING_MIN = 0.35;
const RATING_MAX = 2.2;
const PLAYER_MINUTES_PER_TEAM_MATCH = 990;

const LOG_FACT = [0];
for (let k = 1; k <= 40; k++) LOG_FACT[k] = LOG_FACT[k - 1] + Math.log(k);
const poissonLL = (k, lam) => k * Math.log(lam) - lam - LOG_FACT[Math.min(k, 40)];
const clampRating = (v) => Math.min(RATING_MAX, Math.max(RATING_MIN, v));
const safeLog = (v) => Math.log(Math.min(5, Math.max(0.2, v)));

// ---------------------------------------------------------------------------
// Season preparation
// ---------------------------------------------------------------------------

const datasetCache = new Map();
function dataset(season) {
  if (!datasetCache.has(season)) datasetCache.set(season, loadSeason(season));
  return datasetCache.get(season);
}

function fixtureXg(ds) {
  const out = new Map();
  for (const r of ds.rows) {
    if (!out.has(r.fixtureId)) out.set(r.fixtureId, { h: 0, a: 0, covered: true });
    const x = out.get(r.fixtureId);
    if (r.hasExpectedData === false) x.covered = false;
    if (r.wasHome) x.h += r.xG;
    else x.a += r.xG;
  }
  return out;
}

// Last season, as production can hold it: per-player totals by code (the
// shipped baseline's shape) and, for the C2 arm only, per-club team xG.
function priorSeasonSummary(prev) {
  const byCode = new Map();
  for (const r of prev.rows) {
    const p = prev.players.get(r.playerId);
    if (!p || p.code === null || p.code === undefined) continue;
    // Only rows that carried expected data may divide expected data (2022-23
    // gameweeks 1-15 have none).
    if (r.hasExpectedData === false) continue;
    if (!byCode.has(p.code)) byCode.set(p.code, { xg: 0, xgc: 0, min: 0 });
    const t = byCode.get(p.code);
    t.xg += r.xG;
    t.xgc += r.xGC;
    t.min += r.minutes;
  }
  const fx = fixtureXg(prev);
  const clubs = new Map();
  let goals = 0;
  let home = 0;
  let away = 0;
  let matches = 0;
  for (const f of prev.fixtures) {
    if (f.teamHScore === null || f.teamAScore === null) continue;
    matches++;
    goals += f.teamHScore + f.teamAScore;
    home += f.teamHScore;
    away += f.teamAScore;
    const x = fx.get(f.id);
    if (!x || !x.covered) continue;
    for (const [id, xf, xa] of [[f.teamH, x.h, x.a], [f.teamA, x.a, x.h]]) {
      const name = prev.teams.get(id).name;
      if (!clubs.has(name)) clubs.set(name, { xgFor: 0, xgAgainst: 0, matches: 0 });
      const c = clubs.get(name);
      c.xgFor += xf;
      c.xgAgainst += xa;
      c.matches++;
    }
  }
  let xf = 0;
  let xm = 0;
  for (const c of clubs.values()) { xf += c.xgFor; xm += c.matches; }
  return {
    byCode,
    clubs,
    clubXgRef: xm > 0 ? xf / xm : null,
    goalsPerTeamMatch: matches ? goals / (2 * matches) : 1.4,
    homeAwayGoalRatio: away > 0 ? home / away : HA_PRIOR,
  };
}

function prepareSeason(season) {
  const ds = dataset(season);
  const prevName = previousSeason(season);
  const prev = prevName && fs.existsSync(seasonPath(prevName)) ? dataset(prevName) : null;
  if (!prev) throw new Error(`calibrate-strength: ${season} needs ${prevName} downloaded`);
  const prior = priorSeasonSummary(prev);
  const fx = fixtureXg(ds);
  const teamIds = [...ds.teams.keys()];
  const nameOf = (id) => ds.teams.get(id).name;
  const promoted = new Set(teamIds.filter(id => !prior.clubs.has(nameOf(id))));

  // Club a player is registered to for gameweek g: his first row at or after
  // g. A player with no later row is no longer registered.
  const clubAt = new Map();
  for (const p of ds.players.values()) {
    const rows = p.rows;
    const arr = new Array(ds.maxGw + 2).fill(null);
    let j = 0;
    for (let g = 1; g <= ds.maxGw; g++) {
      while (j < rows.length && rows[j].gw < g) j++;
      arr[g] = j < rows.length ? ds.nameToId.get(rows[j].teamName) || null : null;
    }
    clubAt.set(p.id, arr);
  }

  const running = new Map();
  for (const p of ds.players.values()) running.set(p.id, { xg: 0, xgc: 0, min: 0 });

  const signals = [null];
  for (let g = 1; g <= ds.maxGw; g++) {
    if (g > 1) {
      const gwMap = ds.byGw.get(g - 1);
      if (gwMap) {
        for (const [pid, list] of gwMap) {
          const t = running.get(pid);
          for (const r of list) { t.xg += r.xG; t.xgc += r.xGC; t.min += r.minutes; }
        }
      }
    }
    const cur = new Map(teamIds.map(id => [id, { xg: 0, xgc: 0, min: 0 }]));
    const priorSquad = new Map(teamIds.map(id => [id, { xg: 0, xgc: 0, min: 0 }]));
    const legacyPlayers = [];
    for (const p of ds.players.values()) {
      const club = clubAt.get(p.id)[g];
      if (!club) continue;
      const t = running.get(p.id);
      if (t.min > 0) {
        const c = cur.get(club);
        c.xg += t.xg; c.xgc += t.xgc; c.min += t.min;
      }
      const pr = p.code !== null ? prior.byCode.get(p.code) : null;
      if (pr && pr.min > 0) {
        const c = priorSquad.get(club);
        c.xg += pr.xg; c.xgc += pr.xgc; c.min += pr.min;
      }
      legacyPlayers.push({ id: p.id, teamId: club, cur: { ...t }, prior: pr });
    }

    const nClub = new Map(teamIds.map(id => [id, 0]));
    const before = [];
    let goals = 0;
    let homeGoals = 0;
    let awayGoals = 0;
    for (const f of ds.fixtures) {
      if (f.event >= g) continue;
      nClub.set(f.teamH, nClub.get(f.teamH) + 1);
      nClub.set(f.teamA, nClub.get(f.teamA) + 1);
      const x = fx.get(f.id) || { h: 0, a: 0 };
      before.push({ event: f.event, home: f.teamH, away: f.teamA, gh: f.teamHScore, ga: f.teamAScore, xh: x.h, xa: x.a });
      goals += f.teamHScore + f.teamAScore;
      homeGoals += f.teamHScore;
      awayGoals += f.teamAScore;
    }
    const at = ds.fixtures.filter(f => f.event === g).map(f => {
      const x = fx.get(f.id) || { h: 0, a: 0 };
      return { id: f.id, home: f.teamH, away: f.teamA, gh: f.teamHScore, ga: f.teamAScore, xh: x.h, xa: x.a };
    });

    // League level and home advantage, shared by every arm: last season's
    // level carried as LEVEL_PRIOR_MATCHES matches, home advantage pulled to
    // the engine's prior the same way.
    const m = before.length;
    const mbar0 = prior.goalsPerTeamMatch;
    const mbar = (goals + 2 * LEVEL_PRIOR_MATCHES * mbar0) / (2 * (m + LEVEL_PRIOR_MATCHES));
    const awayLevel0 = 2 * mbar0 / (1 + HA_PRIOR);
    const ha = (homeGoals + LEVEL_PRIOR_MATCHES * awayLevel0 * HA_PRIOR) / (awayGoals + LEVEL_PRIOR_MATCHES * awayLevel0);

    signals.push({ g, cur, priorSquad, nClub, before, at, mbar, ha, legacyPlayers });
  }

  return { season, ds, prev, prior, teamIds, promoted, signals, nameOf };
}

// ---------------------------------------------------------------------------
// Rating constructions
// ---------------------------------------------------------------------------

function relFrom(agg) {
  let X = 0;
  let C = 0;
  let M = 0;
  for (const v of agg.values()) { X += v.xg; C += v.xgc; M += v.min; }
  if (M <= 0 || X <= 0 || C <= 0) return () => null;
  const refA = X / (M / PLAYER_MINUTES_PER_TEAM_MATCH);
  const refD = C / (M / 90);
  return (id) => {
    const v = agg.get(id);
    if (!v || v.min <= 0) return null;
    return {
      att: (v.xg / (v.min / PLAYER_MINUTES_PER_TEAM_MATCH)) / refA,
      def: (v.xgc / (v.min / 90)) / refD,
      min: v.min,
    };
  };
}

function squadPriorLog(sig, id, P, cache) {
  if (!cache.priorRel) cache.priorRel = relFrom(sig.priorSquad);
  const r = cache.priorRel(id);
  const cov = r ? r.min / (r.min + P.Mc) : 0;
  return {
    la: (r ? cov * P.sa * safeLog(r.att) : 0) + (1 - cov) * Math.log(P.pa),
    ld: (r ? cov * P.sd * safeLog(r.def) : 0) + (1 - cov) * Math.log(P.pd),
  };
}

function clubPriorLog(S, id, P) {
  const c = S.prior.clubs.get(S.nameOf(id));
  if (!c || !c.matches || !S.prior.clubXgRef) return { la: Math.log(P.pa2), ld: Math.log(P.pd2) };
  return {
    la: P.sca * safeLog((c.xgFor / c.matches) / S.prior.clubXgRef),
    ld: P.scd * safeLog((c.xgAgainst / c.matches) / S.prior.clubXgRef),
  };
}

function ipf(matches, ids, prior, awayLevel, ha, pw, key, g) {
  if (!Number.isFinite(pw)) return prior;
  const att = new Map();
  const def = new Map();
  const per = new Map();
  for (const id of ids) {
    att.set(id, prior.get(id).att);
    def.set(id, prior.get(id).def);
    per.set(id, []);
  }
  for (const m of matches) {
    const w = Math.pow(0.5, Math.max(0, g - 1 - m.event) / RECENCY_HALF_LIFE_GWS);
    const sh = key === 'x' ? m.xh : m.gh;
    const sa = key === 'x' ? m.xa : m.ga;
    per.get(m.home).push({ opp: m.away, home: true, w, s: sh, c: sa });
    per.get(m.away).push({ opp: m.home, home: false, w, s: sa, c: sh });
  }
  const avgLevel = awayLevel * (1 + ha) / 2;
  for (let it = 0; it < IPF_ITERATIONS; it++) {
    for (const id of ids) {
      let sF = 0;
      let sA = 0;
      let eF = 0;
      let eA = 0;
      for (const e of per.get(id)) {
        sF += e.w * e.s;
        sA += e.w * e.c;
        eF += e.w * awayLevel * def.get(e.opp) * (e.home ? ha : 1);
        eA += e.w * awayLevel * att.get(e.opp) * (e.home ? 1 : ha);
      }
      const p = prior.get(id);
      att.set(id, clampRating((sF + pw * avgLevel * p.att) / Math.max(1e-9, eF + pw * avgLevel)));
      def.set(id, clampRating((sA + pw * avgLevel * p.def) / Math.max(1e-9, eA + pw * avgLevel)));
    }
  }
  const out = new Map();
  for (const id of ids) out.set(id, { att: att.get(id), def: def.get(id) });
  return out;
}

function normalise(ratings) {
  let sa = 0;
  let sd = 0;
  for (const r of ratings.values()) { sa += r.att; sd += r.def; }
  const n = ratings.size;
  const out = new Map();
  for (const [id, r] of ratings) {
    out.set(id, { att: clampRating(r.att / (sa / n)), def: clampRating(r.def / (sd / n)) });
  }
  return out;
}

// Build ratings for one season-state under an arm and parameter set.
function ratingsFor(arm, S, sig, P) {
  const ids = S.teamIds;
  const cache = {};
  const awayLevel = 2 * sig.mbar / (1 + sig.ha);
  const flat = () => new Map(ids.map(id => [id, { att: 1, def: 1 }]));

  if (arm === 'base') return flat();

  const priorLogs = (id) => {
    if (arm === 'B' || arm === 'G') return { la: 0, ld: 0 };
    if (arm === 'C2') return clubPriorLog(S, id, P);
    const sq = squadPriorLog(sig, id, P, cache);
    if (arm !== 'D2G') return sq;
    const cl = clubPriorLog(S, id, P);
    // A promoted club has no club row; its prior is the squad construction.
    const hasClub = S.prior.clubs.has(S.nameOf(id));
    const w = hasClub ? P.omega : 1;
    return { la: w * sq.la + (1 - w) * cl.la, ld: w * sq.ld + (1 - w) * cl.ld };
  };

  const useCurrentXg = ['B', 'D', 'DG', 'D2G'].includes(arm);
  if (useCurrentXg && !cache.curRel) cache.curRel = relFrom(sig.cur);

  let ratings = new Map();
  for (const id of ids) {
    const pl = priorLogs(id);
    let la = pl.la;
    let ld = pl.ld;
    if (useCurrentXg) {
      const r = cache.curRel(id);
      const n = sig.nClub.get(id);
      if (r && n > 0) {
        if (Number.isFinite(P.Kxa)) la = (P.Kxa * la + n * safeLog(r.att)) / (P.Kxa + n);
        if (Number.isFinite(P.Kxd)) ld = (P.Kxd * ld + n * safeLog(r.def)) / (P.Kxd + n);
      }
    }
    ratings.set(id, { att: Math.exp(la), def: Math.exp(ld) });
  }
  ratings = normalise(ratings);

  if (arm === 'E') ratings = normalise(ipf(sig.before, ids, ratings, awayLevel, sig.ha, P.PWx, 'x', sig.g));
  if (['G', 'DG', 'D2G', 'E'].includes(arm)) ratings = normalise(ipf(sig.before, ids, ratings, awayLevel, sig.ha, P.PW, 'g', sig.g));
  return ratings;
}

// The current engine, on the state production builds today.
function engineLambdas(S, sig) {
  const g = sig.g;
  let minPlayed = Infinity;
  for (const n of sig.nClub.values()) minPlayed = Math.min(minPlayed, n);
  const superseded = minPlayed >= 3;
  const players = new Map();
  for (const lp of sig.legacyPlayers) {
    let xG = 0;
    let xGC = 0;
    let minutes = 0;
    const addPrior = g === 1 || !superseded;
    const addCurrent = g > 1;
    if (addPrior && lp.prior) { xG += lp.prior.xg; xGC += lp.prior.xgc; minutes += lp.prior.min; }
    if (addCurrent) { xG += lp.cur.xg; xGC += lp.cur.xgc; minutes += lp.cur.min; }
    players.set(lp.id, { id: lp.id, teamId: lp.teamId, xG, xGC, minutes });
  }
  const teams = new Map(S.teamIds.map(id => [id, { id, strengthOverallHome: 3, strengthOverallAway: 3 }]));
  const fixtures = S.ds.fixtures.map(f => ({
    id: f.id, event: f.event, teamH: f.teamH, teamA: f.teamA,
    finished: f.event < g, finishedProvisional: false, started: f.event < g,
    teamHScore: f.event < g ? f.teamHScore : null,
    teamAScore: f.event < g ? f.teamAScore : null,
  }));
  const strength = buildStrength({ teams, players, fixtures, rules: { starters: 11 }, nextEvent: g }, { asOfGw: g });
  return (home, away) => {
    const e = expectedGoals(strength, home, away);
    return { h: e.xGH, a: e.xGA };
  };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function evaluate(arm, seasons, P, { gFrom = 1, gTo = 38, detail = false } = {}) {
  let ll = 0;
  const seg = detail ? { gw1to3: blank(), gw4to10: blank(), early: blank(), late: blank(), all: blank(), promotedEarly: blank() } : null;
  for (const S of seasons) {
    for (let g = gFrom; g <= Math.min(gTo, S.ds.maxGw); g++) {
      const sig = S.signals[g];
      if (!sig.at.length) continue;
      let lam;
      if (arm === 'A') {
        lam = engineLambdas(S, sig);
      } else {
        const R = ratingsFor(arm, S, sig, P);
        const awayLevel = 2 * sig.mbar / (1 + sig.ha);
        lam = (h, a) => ({
          h: awayLevel * sig.ha * R.get(h).att * R.get(a).def,
          a: awayLevel * R.get(a).att * R.get(h).def,
        });
      }
      for (const f of sig.at) {
        const l = lam(f.home, f.away);
        const v = poissonLL(f.gh, l.h) + poissonLL(f.ga, l.a);
        ll += v;
        if (detail) {
          const awayLevel = 2 * sig.mbar / (1 + sig.ha);
          const bh = awayLevel * sig.ha;
          const ba = awayLevel;
          const b = poissonLL(f.gh, bh) + poissonLL(f.ga, ba);
          const se = (l.h - f.xh) ** 2 + (l.a - f.xa) ** 2;
          const seB = (bh - f.xh) ** 2 + (ba - f.xa) ** 2;
          const add = (s) => { s.dll += v - b; s.sides += 2; s.se += se; s.seBase += seB; };
          add(seg.all);
          add(g <= 10 ? seg.early : seg.late);
          if (g <= 3) add(seg.gw1to3);
          else if (g <= 10) add(seg.gw4to10);
          if (g <= 10 && (S.promoted.has(f.home) || S.promoted.has(f.away))) add(seg.promotedEarly);
        }
      }
    }
  }
  return detail ? { ll, seg } : ll;
}

function blank() { return { dll: 0, sides: 0, se: 0, seBase: 0 }; }

// ---------------------------------------------------------------------------
// Fitting: coordinate descent over one-dimensional grids.
// ---------------------------------------------------------------------------

const GRID = {
  sa: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.4],
  sd: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.4],
  Mc: [250, 500, 1000, 2000, 4000, 8000, 16000, 32000, 64000],
  pa: [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
  pd: [1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.7, 2.0, 2.4],
  Kxa: [0.5, 1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 72, Infinity],
  Kxd: [0.5, 1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 72, Infinity],
  PW: [1, 2, 4, 6, 10, 16, 25, 40, 64, 100, 160, 250, 400, 1000, Infinity],
  PWx: [1, 2, 4, 6, 10, 16, 25, 40, 64, 100, 250, Infinity],
  sca: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.3],
  scd: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.3],
  pa2: [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
  pd2: [1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.7, 2.0, 2.4],
  omega: [0, 0.25, 0.5, 0.75, 1],
};

const START = {
  sa: 0.7, sd: 0.7, Mc: 2000, pa: 0.8, pd: 1.2,
  Kxa: 8, Kxd: 8, PW: 10, PWx: 10,
  sca: 0.7, scd: 0.7, pa2: 0.8, pd2: 1.2, omega: 0.5,
};

const ARM_PARAMS = {
  base: [],
  A: [],
  B: ['Kxa', 'Kxd'],
  C: ['sa', 'sd', 'Mc', 'pa', 'pd'],
  C2: ['sca', 'scd', 'pa2', 'pd2'],
  D: ['sa', 'sd', 'Mc', 'pa', 'pd', 'Kxa', 'Kxd'],
  G: ['PW'],
  DG: ['sa', 'sd', 'Mc', 'pa', 'pd', 'Kxa', 'Kxd', 'PW'],
  D2G: ['sa', 'sd', 'Mc', 'pa', 'pd', 'sca', 'scd', 'pa2', 'pd2', 'omega', 'Kxa', 'Kxd', 'PW'],
  E: ['sa', 'sd', 'Mc', 'pa', 'pd', 'PWx', 'PW'],
};

// Fitting cheap arms first lets the expensive IPF arms start near their optimum.
const WARM_START = { DG: 'D', D2G: 'DG', E: 'C' };

function fit(arm, seasons, warm = null, { gFrom = 1, gTo = 38 } = {}) {
  const names = ARM_PARAMS[arm];
  const P = { ...START, ...(warm || {}) };
  if (!names.length) return { params: {}, ll: evaluate(arm, seasons, P, { gFrom, gTo }) };
  let best = evaluate(arm, seasons, P, { gFrom, gTo });
  const passes = QUICK ? 2 : 4;
  for (let pass = 0; pass < passes; pass++) {
    let improved = false;
    for (const name of names) {
      for (const v of GRID[name]) {
        if (v === P[name]) continue;
        const trial = { ...P, [name]: v };
        const ll = evaluate(arm, seasons, trial, { gFrom, gTo });
        if (ll > best + 1e-9) { best = ll; P[name] = v; improved = true; }
      }
    }
    if (!improved) break;
  }
  return { params: Object.fromEntries(names.map(n => [n, P[n]])), ll: best };
}

// ---------------------------------------------------------------------------
// Home advantage
// ---------------------------------------------------------------------------

function homeAdvantageStudy(S) {
  const ds = S.ds;
  const fx = fixtureXg(ds);
  let hg = 0;
  let ag = 0;
  let hx = 0;
  let ax = 0;
  for (const f of ds.fixtures) {
    hg += f.teamHScore; ag += f.teamAScore;
    const x = fx.get(f.id);
    hx += x.h; ax += x.a;
  }

  // Player-level: pooled per-90 xG at home over away, for players with 900+
  // minutes at each venue; and the log-mean of the per-player ratio.
  const byPlayer = new Map();
  for (const r of ds.rows) {
    if (!(r.minutes > 0)) continue;
    if (!byPlayer.has(r.playerId)) byPlayer.set(r.playerId, { hx: 0, hm: 0, ax: 0, am: 0 });
    const t = byPlayer.get(r.playerId);
    if (r.wasHome) { t.hx += r.xG; t.hm += r.minutes; } else { t.ax += r.xG; t.am += r.minutes; }
  }
  let phx = 0;
  let phm = 0;
  let pax = 0;
  let pam = 0;
  let logSum = 0;
  let logN = 0;
  for (const t of byPlayer.values()) {
    if (t.hm < 900 || t.am < 900) continue;
    phx += t.hx; phm += t.hm; pax += t.ax; pam += t.am;
    if (t.hx > 0 && t.ax > 0) { logSum += Math.log((t.hx / t.hm) / (t.ax / t.am)); logN++; }
  }

  // Full-season ratings from per-fixture xG IPF, engine-style: home factor HA,
  // away 1, ratings recentred on a GEOMETRIC mean of 1 as strength.js does.
  const ids = S.teamIds;
  const haX = hx / ax;
  const levelAway = (hx + ax) / (2 * ds.fixtures.length) * 2 / (1 + haX);
  const flat = new Map(ids.map(id => [id, { att: 1, def: 1 }]));
  const matches = ds.fixtures.map(f => ({ event: 1, home: f.teamH, away: f.teamA, xh: fx.get(f.id).h, xa: fx.get(f.id).a }));
  const raw = ipf(matches, ids, flat, levelAway, haX, 1e-6, 'x', 1);
  const geo = (vals) => Math.exp(vals.reduce((s, v) => s + Math.log(v), 0) / vals.length);
  const ga = geo([...raw.values()].map(r => r.att));
  const gd = geo([...raw.values()].map(r => r.def));
  const R = new Map([...raw].map(([id, r]) => [id, { att: r.att / ga, def: r.def / gd }]));
  const arithDef = [...R.values()].reduce((s, r) => s + r.def, 0) / R.size;
  const arithAtt = [...R.values()].reduce((s, r) => s + r.att, 0) / R.size;

  // Out-of-sample check of the scale normalisation. Rates from gameweeks
  // 1-19, projected onto the xG and xGC of gameweeks 20-38 with the engine's
  // scale (old), divided by the average venue factor (1+HA)/2 (new), and by
  // that factor times the arithmetic mean opponent rating (new + opp).
  const rate = new Map();
  for (const r of ds.rows) {
    if (r.gw > 19 || !(r.minutes > 0)) continue;
    if (!rate.has(r.playerId)) rate.set(r.playerId, { x: 0, c: 0, m: 0 });
    const t = rate.get(r.playerId);
    t.x += r.xG; t.c += r.xGC; t.m += r.minutes;
  }
  const vbar = (1 + haX) / 2;
  const acc = { actX: 0, oldX: 0, newX: 0, newOppX: 0, actC: 0, oldC: 0, newC: 0, newOppC: 0 };
  for (const r of ds.rows) {
    if (r.gw < 20 || !(r.minutes > 0)) continue;
    const t = rate.get(r.playerId);
    if (!t || t.m < 450) continue;
    const own = ds.nameToId.get(r.teamName);
    const opp = r.opponentTeam;
    if (!R.has(own) || !R.has(opp)) continue;
    const share = r.minutes / 90;
    const attackScale = R.get(opp).def * (r.wasHome ? haX : 1);
    const defenceScale = R.get(opp).att * (r.wasHome ? 1 : haX);
    const px = (t.x / (t.m / 90)) * share;
    const pc = (t.c / (t.m / 90)) * share;
    acc.actX += r.xG; acc.actC += r.xGC;
    acc.oldX += px * attackScale; acc.oldC += pc * defenceScale;
    acc.newX += px * attackScale / vbar; acc.newC += pc * defenceScale / vbar;
    acc.newOppX += px * attackScale / (vbar * arithDef); acc.newOppC += pc * defenceScale / (vbar * arithAtt);
  }
  return {
    season: S.season,
    homeAwayGoalRatio: +(hg / ag).toFixed(4),
    homeAwayXgRatio: +(hx / ax).toFixed(4),
    playerPooledHomeAwayXg90Ratio: +((phx / phm) / (pax / pam)).toFixed(4),
    playerLogMeanHomeAwayXg90Ratio: logN ? +Math.exp(logSum / logN).toFixed(4) : null,
    playersWith900EachVenue: logN,
    averageVenueFactor: +vbar.toFixed(4),
    arithmeticMeanOfGeoCentredRatings: { attack: +arithAtt.toFixed(4), defence: +arithDef.toFixed(4) },
    secondHalfProjectedOverActual: {
      xG: { engineScale: +(acc.oldX / acc.actX).toFixed(4), dividedByVenue: +(acc.newX / acc.actX).toFixed(4), dividedByVenueAndOppMean: +(acc.newOppX / acc.actX).toFixed(4) },
      xGC: { engineScale: +(acc.oldC / acc.actC).toFixed(4), dividedByVenue: +(acc.newC / acc.actC).toFixed(4), dividedByVenueAndOppMean: +(acc.newOppC / acc.actC).toFixed(4) },
    },
  };
}

function haPriorSweep(seasons) {
  const out = [];
  for (const v of [1.0, 1.05, 1.1, 1.15, 1.2, 1.25, 1.3]) {
    let ll = 0;
    for (const S of seasons) {
      for (let g = 1; g <= S.ds.maxGw; g++) {
        const sig = S.signals[g];
        let hg = 0;
        let ag = 0;
        for (const f of sig.before) { hg += f.gh; ag += f.ga; }
        const awayLevel0 = 2 * S.prior.goalsPerTeamMatch / (1 + v);
        const ha = (hg + LEVEL_PRIOR_MATCHES * awayLevel0 * v) / (ag + LEVEL_PRIOR_MATCHES * awayLevel0);
        const awayLevel = 2 * sig.mbar / (1 + ha);
        for (const f of sig.at) ll += poissonLL(f.gh, awayLevel * ha) + poissonLL(f.ga, awayLevel);
      }
    }
    out.push({ haPrior: v, leagueMeanLL: +ll.toFixed(2) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Live 2026-27 sanity check (read-only, full-fit parameters)
// ---------------------------------------------------------------------------

function liveSanity(params, prior2526) {
  if (!LIVE_DIR) return { skipped: 'no --live directory given' };
  const bootFile = path.join(LIVE_DIR, 'bootstrap.json');
  const fixFile = path.join(LIVE_DIR, 'fixtures.json');
  if (!fs.existsSync(bootFile) || !fs.existsSync(fixFile)) return { skipped: `no bootstrap.json and fixtures.json in ${LIVE_DIR}` };
  const bootstrap = JSON.parse(fs.readFileSync(bootFile, 'utf8'));
  const fixtures = JSON.parse(fs.readFileSync(fixFile, 'utf8'));
  const baseline = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'data', 'opening-baseline.json'), 'utf8'));
  const g = bootstrap.events.find(e => e.is_next).id;
  const teamIds = bootstrap.teams.map(t => t.id);
  const nameOf = (id) => bootstrap.teams.find(t => t.id === id).name;
  const shortOf = (id) => bootstrap.teams.find(t => t.id === id).short_name;
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

  const cur = new Map(teamIds.map(id => [id, { xg: 0, xgc: 0, min: 0 }]));
  const priorSquad = new Map(teamIds.map(id => [id, { xg: 0, xgc: 0, min: 0 }]));
  const byCode = new Map(Object.values(baseline.totals).map(r => [r.c, r]));
  let priorGoals = 0;
  for (const r of Object.values(baseline.totals)) priorGoals += (r.gs || 0) + (r.og || 0);
  for (const e of bootstrap.elements) {
    const c = cur.get(e.team);
    if (num(e.minutes) > 0) { c.xg += num(e.expected_goals); c.xgc += num(e.expected_goals_conceded); c.min += num(e.minutes); }
    const r = byCode.get(e.code);
    if (r && r.m > 0) {
      const p = priorSquad.get(e.team);
      p.xg += r.xg || 0; p.xgc += r.xgc || 0; p.min += r.m;
    }
  }
  const nClub = new Map(teamIds.map(id => [id, 0]));
  const before = [];
  let goals = 0;
  let hgs = 0;
  let ags = 0;
  for (const f of fixtures) {
    if (f.event === null || f.event >= g) continue;
    if (!(f.finished || f.finished_provisional)) continue;
    nClub.set(f.team_h, nClub.get(f.team_h) + 1);
    nClub.set(f.team_a, nClub.get(f.team_a) + 1);
    before.push({ event: f.event, home: f.team_h, away: f.team_a, gh: f.team_h_score, ga: f.team_a_score });
    goals += f.team_h_score + f.team_a_score; hgs += f.team_h_score; ags += f.team_a_score;
  }
  const mbar0 = priorGoals / 760;
  const m = before.length;
  const mbar = (goals + 2 * LEVEL_PRIOR_MATCHES * mbar0) / (2 * (m + LEVEL_PRIOR_MATCHES));
  const awayLevel0 = 2 * mbar0 / (1 + HA_PRIOR);
  const ha = (hgs + LEVEL_PRIOR_MATCHES * awayLevel0 * HA_PRIOR) / (ags + LEVEL_PRIOR_MATCHES * awayLevel0);
  const sig = { g, cur, priorSquad, nClub, before, at: [], mbar, ha };
  const S = { teamIds, nameOf, prior: prior2526 };

  const tables = {};
  for (const arm of ['DG', 'D2G']) {
    if (!params[arm]) continue;
    const R = ratingsFor(arm, S, sig, { ...START, ...params[arm] });
    const awayLevel = 2 * mbar / (1 + ha);
    const ratings = teamIds.map(id => ({ team: shortOf(id), attack: +R.get(id).att.toFixed(3), defence: +R.get(id).def.toFixed(3) }))
      .sort((a, b) => b.attack - a.attack);
    const gwFixtures = fixtures.filter(f => f.event === g).map(f => {
      const lh = awayLevel * ha * R.get(f.team_h).att * R.get(f.team_a).def;
      const la = awayLevel * R.get(f.team_a).att * R.get(f.team_h).def;
      return { fixture: `${shortOf(f.team_h)} v ${shortOf(f.team_a)}`, xgHome: +lh.toFixed(2), xgAway: +la.toFixed(2), pCsHome: +Math.exp(-la).toFixed(2), pCsAway: +Math.exp(-lh).toFixed(2) };
    });
    tables[arm] = { ratings, fixtures: gwFixtures };
  }

  // The current engine on the same payload, for comparison.
  const gs = buildGameState(bootstrap, fixtures, {});
  const st = buildStrength(gs, { asOfGw: g });
  tables.currentEngine = {
    mu: +st.leagueMeanGoals.toFixed(4),
    homeAdvantage: +st.homeAdvantage.toFixed(4),
    ratings: teamIds.map(id => ({ team: shortOf(id), attack: +st.teams.get(id).attack.toFixed(3), defence: +st.teams.get(id).defence.toFixed(3) })).sort((a, b) => b.attack - a.attack),
    fixtures: fixtures.filter(f => f.event === g).map(f => {
      const e = expectedGoals(st, f.team_h, f.team_a);
      return { fixture: `${shortOf(f.team_h)} v ${shortOf(f.team_a)}`, xgHome: +e.xGH.toFixed(2), xgAway: +e.xGA.toFixed(2) };
    }),
  };
  return { gameweek: g, leagueMeanGoalsPerTeamMatch: +mbar.toFixed(4), homeAdvantage: +ha.toFixed(4), tables };
}

// ---------------------------------------------------------------------------

function round(obj) {
  return JSON.parse(JSON.stringify(obj, (k, v) => (typeof v === 'number' ? (Number.isFinite(v) ? +v.toFixed(5) : String(v)) : v)));
}

async function main() {
  const t0 = Date.now();
  const seasons = TARGETS.map(prepareSeason);
  console.log(`prepared ${seasons.length} seasons in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const arms = ['base', 'A', 'B', 'C', 'C2', 'D', 'G', 'DG', 'D2G', 'E'];
  const heldOut = [];
  const loso = {};
  for (const S of seasons) {
    const train = seasons.filter(x => x !== S);
    loso[S.season] = {};
    for (const arm of arms) {
      const warm = WARM_START[arm] ? loso[S.season][WARM_START[arm]] : null;
      const f = fit(arm, train, warm);
      loso[S.season][arm] = f.params;
      const ev = evaluate(arm, [S], { ...START, ...f.params }, { detail: true });
      for (const [segName, s] of Object.entries(ev.seg)) {
        if (!s.sides) continue;
        heldOut.push({
          arm, season: S.season, segment: segName, sides: s.sides,
          dllPerSide: s.dll / s.sides,
          xgSkill: 1 - s.se / s.seBase,
        });
      }
      console.log(`${S.season} ${arm.padEnd(4)} fitted ${JSON.stringify(f.params)} held-out dLL/side all ${(ev.seg.all.dll / ev.seg.all.sides).toFixed(4)} early ${(ev.seg.early.dll / ev.seg.early.sides).toFixed(4)}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    }
  }

  // Pooled held-out summary per arm.
  const summary = {};
  for (const arm of arms) {
    summary[arm] = {};
    for (const seg of ['gw1to3', 'gw4to10', 'early', 'late', 'all', 'promotedEarly']) {
      const rows = heldOut.filter(r => r.arm === arm && r.segment === seg);
      const sides = rows.reduce((s, r) => s + r.sides, 0);
      summary[arm][seg] = {
        dllPerSide: rows.reduce((s, r) => s + r.dllPerSide * r.sides, 0) / sides,
        xgSkill: rows.reduce((s, r) => s + r.xgSkill * r.sides, 0) / sides,
        bySeason: Object.fromEntries(rows.map(r => [r.season, r.dllPerSide])),
      };
    }
  }

  // Full fit on all three seasons: the parameters production would ship.
  const full = {};
  for (const arm of arms) {
    const warm = WARM_START[arm] ? full[WARM_START[arm]] : null;
    full[arm] = fit(arm, seasons, warm).params;
  }
  // Stability: the same arm fitted on gameweeks 1-10 only.
  const fullEarlyOnly = {};
  for (const arm of ['D', 'DG']) {
    const warm = arm === 'DG' ? fullEarlyOnly.D : null;
    fullEarlyOnly[arm] = fit(arm, seasons, warm, { gFrom: 1, gTo: 10 }).params;
  }

  const homeAdvantage = seasons.map(homeAdvantageStudy);
  const haSweep = haPriorSweep(seasons);
  const prior2526 = priorSeasonSummary(dataset('2025-26'));
  const live = liveSanity(full, prior2526);

  const result = round({
    generatedAt: new Date().toISOString(),
    targets: TARGETS,
    quick: QUICK,
    shared: { haPrior: HA_PRIOR, levelPriorMatches: LEVEL_PRIOR_MATCHES, recencyHalfLifeGws: RECENCY_HALF_LIFE_GWS, ipfIterations: IPF_ITERATIONS },
    heldOutSummary: summary,
    heldOut,
    losoParams: loso,
    fullParams: full,
    fullEarlyOnlyParams: fullEarlyOnly,
    homeAdvantage,
    haPriorSweep: haSweep,
    live,
    runtimeSeconds: (Date.now() - t0) / 1000,
  });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 1));

  console.log('\nHELD-OUT (leave-one-season-out), dLL per side vs league mean, then xG skill (1 - SE/SE_base)');
  console.log('arm   gw1-3            gw4-10           early g1-10      late g11-38      all              promoted g1-10');
  for (const arm of arms) {
    const s = summary[arm];
    const cell = (x) => `${x.dllPerSide.toFixed(4).padStart(7)} ${x.xgSkill.toFixed(3).padStart(6)}`;
    console.log(`${arm.padEnd(5)} ${cell(s.gw1to3)}   ${cell(s.gw4to10)}   ${cell(s.early)}   ${cell(s.late)}   ${cell(s.all)}   ${cell(s.promotedEarly)}`);
  }
  console.log('\nHELD-OUT dLL per side by season (early g1-10 | all)');
  for (const arm of arms) {
    const s = summary[arm];
    console.log(`${arm.padEnd(5)} ` + TARGETS.map(t => `${t} ${s.early.bySeason[t].toFixed(4)} | ${s.all.bySeason[t].toFixed(4)}`).join('   '));
  }

  console.log('\nFULL-FIT PARAMETERS');
  for (const arm of arms) console.log(arm.padEnd(5), JSON.stringify(full[arm]));
  console.log('early-only', JSON.stringify(fullEarlyOnly));
  console.log('\nHOME ADVANTAGE');
  for (const h of homeAdvantage) console.log(JSON.stringify(h));
  console.log(JSON.stringify(haSweep));
  if (live.tables) {
    for (const [name, t] of Object.entries(live.tables)) {
      console.log(`\nLIVE GW${live.gameweek} ${name}`);
      console.log(t.ratings.map(r => `${r.team} ${r.attack}/${r.defence}`).join(', '));
      for (const f of t.fixtures) console.log(`  ${f.fixture.padEnd(10)} ${f.xgHome.toFixed(2)} - ${f.xgAway.toFixed(2)}${f.pCsHome !== undefined ? `  pCS ${f.pCsHome.toFixed(2)}/${f.pCsAway.toFixed(2)}` : ''}`);
    }
  }
  console.log(`\nwrote ${OUT_FILE} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
