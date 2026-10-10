// The live-season accuracy scorecard: projections made from an archived
// pre-deadline payload, scored against what that gameweek then produced, next
// to two references a model has to beat to be worth anything.
//
// WHY THE REFERENCES
//
// A projection's error means nothing on its own. The replay audit of
// 2026-10-09 found the engine level with "points per club match" (Spearman
// 0.589 against 0.598) and only ahead on the top of the ranking, and every
// historical comparison with FPL's own xP leaked the result. An archived
// pre-deadline bootstrap fixes both: its season totals are exactly what was
// known at the deadline (the naive reference), and its `ep_next` is FPL's
// official projection made before the gameweek (an honest official baseline).
//
// THE LEAKAGE GUARD
//
// A payload captured after its gameweek's deadline already knows team news,
// and once matches start it knows minutes. Scoring one would flatter every
// method. `assertPreDeadline` refuses it, on this machine's clock AND on FPL's
// Date header, so a skewed clock cannot sneak a post-deadline payload through.

import { buildGameState } from '../../js/engine/normalize.js';
import { openingBaselineApplies, resolveGameState } from '../../js/engine/world.js';
import { buildStrength } from '../../js/engine/strength.js';
import { buildProjections } from '../../js/engine/projections.js';
import { matchesKickedOffByClub } from '../../js/engine/lifecycle.js';

export const METHODS = Object.freeze(['engine', 'naive', 'fpl']);
export const METHOD_LABELS = Object.freeze({
  engine: 'engine (as the app shows it)',
  naive: 'points per club match',
  fpl: "FPL's ep_next",
});
export const START_BINS = Object.freeze([0, 0.1, 0.3, 0.5, 0.7, 0.9, 1.0001]);
export const DRIFT_RUN = 3;

/* ---------------------------------------------------------- leakage guard */

/**
 * Throws unless the payload was captured strictly before `deadline`, by both
 * clocks it carries. A missing capture time is a refusal too: an undated
 * payload cannot be shown to predate anything.
 */
export function assertPreDeadline({ capturedAt, serverDate = null }, deadline, what = 'snapshot') {
  const d = Date.parse(deadline);
  if (!Number.isFinite(d)) throw new Error(`${what}: refused, no deadline to check against`);
  const c = Date.parse(capturedAt);
  if (!Number.isFinite(c)) throw new Error(`${what}: refused, no capture time`);
  const late = [];
  if (c >= d) late.push(`captured ${capturedAt}`);
  if (serverDate && Number.isFinite(Date.parse(serverDate)) && Date.parse(serverDate) >= d) late.push(`FPL dated it ${serverDate}`);
  if (late.length) {
    const err = new Error(`${what}: refused, ${late.join(' and ')}, at or after the deadline ${deadline}; scoring it would leak the gameweek`);
    err.leakage = true;
    throw err;
  }
}

/* ----------------------------------------------------------------- metrics */

/** Average ranks (1-based), ties sharing the mean of their positions. */
export function ranks(values) {
  const idx = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(values.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k][1]] = r;
    i = j + 1;
  }
  return out;
}

export function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0; let sxx = 0; let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

export const spearman = (xs, ys) => pearson(ranks(xs), ranks(ys));

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

/**
 * Top-k by prediction, ties broken by id so the result does not depend on the
 * order rows arrived in.
 */
function topBy(rows, key, k) {
  return [...rows].sort((a, b) => (b[key] - a[key]) || (a.id - b.id)).slice(0, k);
}

/**
 * Bias, MAE, RMSE, MAE over 60+ minute players, Spearman, top-20 mean actual
 * points and the top projected player's actual points (raw, not doubled), for
 * the prediction stored under `key` in each row. Rows without a finite
 * prediction for that key are left out, and `n` says how many were scored.
 */
export function methodMetrics(rows, key) {
  const usable = rows.filter((r) => Number.isFinite(r[key]));
  if (!usable.length) return null;
  const err = usable.map((r) => r[key] - r.actual);
  const sixty = usable.filter((r) => r.minutes >= 60);
  const top = topBy(usable, key, 20);
  const captain = topBy(usable, key, 1)[0];
  return {
    n: usable.length,
    bias: mean(err),
    mae: mean(err.map(Math.abs)),
    rmse: Math.sqrt(mean(err.map((e) => e * e))),
    mae60: sixty.length ? mean(sixty.map((r) => Math.abs(r[key] - r.actual))) : null,
    n60: sixty.length,
    spearman: spearman(usable.map((r) => r[key]), usable.map((r) => r.actual)),
    top20: mean(top.map((r) => r.actual)),
    captainId: captain.id,
    captainName: captain.name || null,
    captainPoints: captain.actual,
  };
}

/** Predicted start probability against the observed start rate, by bin. */
export function startCalibration(rows, bins = START_BINS) {
  const out = [];
  for (let i = 0; i < bins.length - 1; i++) {
    const inBin = rows.filter((r) => Number.isFinite(r.pStart) && r.pStart >= bins[i] && r.pStart < bins[i + 1]);
    out.push({
      from: bins[i],
      to: Math.min(1, bins[i + 1]),
      n: inBin.length,
      predicted: inBin.length ? mean(inBin.map((r) => r.pStart)) : null,
      observed: inBin.length ? mean(inBin.map((r) => r.started)) : null,
    });
  }
  return out;
}

export function scoreRows(rows) {
  const methods = {};
  for (const m of METHODS) methods[m] = methodMetrics(rows, m);
  return { n: rows.length, methods, startCalibration: startCalibration(rows) };
}

/* ------------------------------------------------------- the engine's rows */

/** event/{gw}/live as a Map id -> { points, minutes, started }. */
export function actualsFromLive(live) {
  const m = new Map();
  for (const e of live.elements || []) {
    const s = e.stats || {};
    m.set(e.id, { points: Number(s.total_points) || 0, minutes: Number(s.minutes) || 0, started: Number(s.starts) > 0 ? 1 : 0 });
  }
  return m;
}

/**
 * Rebuild the GameState exactly as app.js does for a first-time visitor
 * (engine/world.js, the shipped previous season), project gameweek `gw`, and
 * pair every player with a fixture in it with what he did. The naive reference
 * is his season points so far over his club's matches kicked off, times his
 * fixtures; `fpl` is the payload's own ep_next when the payload's next event is
 * `gw` (null otherwise, never a guess).
 */
export function deadlineRows({ bootstrap, fixtures, capturedAt, gw, actuals, shipped }) {
  const first = buildGameState(bootstrap, fixtures, { fetchedAt: capturedAt });
  const prior = openingBaselineApplies(first) ? shipped : null;
  const { gameState, resolution } = resolveGameState(first, { bootstrap, fixtures, fetchedAt: capturedAt, kept: null, shipped: prior });
  const strength = buildStrength(gameState, { asOfGw: gw });
  const projections = buildProjections({ gameState, strength, gwFrom: gw, gwTo: gw });
  const clubMatches = matchesKickedOffByClub(first);
  const nextEvent = (bootstrap.events.find((e) => e.is_next) || {}).id;
  const raw = new Map(bootstrap.elements.map((e) => [e.id, e]));
  const rows = [];
  for (const [id, list] of projections.byPlayer) {
    const r = list.find((x) => x.gw === gw);
    if (!r || !r.fixtures.length) continue;
    const p = gameState.players.get(id);
    const el = raw.get(id) || {};
    const m = clubMatches.get(p.teamId) || 0;
    const a = actuals.get(id) || { points: 0, minutes: 0, started: 0 };
    const ep = nextEvent === gw && el.ep_next !== undefined && el.ep_next !== null ? Number(el.ep_next) : null;
    rows.push({
      id,
      name: p.webName,
      position: p.position,
      fixtures: r.fixtures.length,
      engine: r.xPoints,
      pStart: r.pStart,
      naive: m > 0 ? ((Number(el.total_points) || 0) / m) * r.fixtures.length : 0,
      fpl: Number.isFinite(ep) ? ep : null,
      actual: a.points,
      minutes: a.minutes,
      started: a.started,
    });
  }
  return { rows, gameState, resolution };
}

/* ------------------------------------------------------- history and drift */

/**
 * Add a per-gameweek row to the cumulative history, replacing an earlier row
 * for the same season, gameweek and snapshot so a re-run is idempotent.
 */
export function upsertHistory(history, row) {
  const key = (r) => `${r.season}|${r.gw}|${r.snapshot}`;
  const kept = (history || []).filter((r) => key(r) !== key(row));
  return [...kept, row].sort((a, b) => (a.season < b.season ? -1 : a.season > b.season ? 1 : a.gw - b.gw));
}

/**
 * Drift: the engine's Spearman below a reference's for `run` consecutive
 * gameweeks (the newest row per gameweek). One week below is noise; three in a
 * row is a trend worth a look before it is a season.
 */
export function driftFlags(history, { run = DRIFT_RUN } = {}) {
  const byGw = new Map();
  for (const r of history) {
    const k = `${r.season}|${r.gw}`;
    const prev = byGw.get(k);
    if (!prev || Date.parse(r.capturedAt) > Date.parse(prev.capturedAt)) byGw.set(k, r);
  }
  const rows = [...byGw.values()].sort((a, b) => (a.season < b.season ? -1 : a.season > b.season ? 1 : a.gw - b.gw));
  const flags = [];
  for (const ref of ['naive', 'fpl']) {
    let streak = [];
    for (const r of rows) {
      const e = r.methods.engine && r.methods.engine.spearman;
      const x = r.methods[ref] && r.methods[ref].spearman;
      if (!Number.isFinite(e) || !Number.isFinite(x)) { streak = []; continue; }
      streak = e < x ? [...streak, r] : [];
    }
    if (streak.length >= run) {
      flags.push({
        reference: ref,
        gameweeks: streak.map((r) => `${r.season} GW${r.gw}`),
        message: `engine Spearman below ${METHOD_LABELS[ref]} for ${streak.length} consecutive gameweeks`,
      });
    }
  }
  return flags;
}

/* -------------------------------------------------------------- rendering */

const f = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : 'n/a');

export function renderMarkdown({ title, generatedAt, results, refused, drift, notes = [] }) {
  const out = [`# ${title}`, '', `Generated ${generatedAt}.`, ''];
  for (const n of notes) out.push(`- ${n}`);
  if (notes.length) out.push('');
  for (const r of results) {
    out.push(`## ${r.season} GW${r.gw}: ${r.snapshot}`, '');
    out.push(`Captured ${r.capturedAt}, ${f(r.hoursBeforeDeadline, 1)}h before the deadline. ${r.n} players with a fixture. Actuals: ${r.actualsSource}.`, '');
    out.push('| method | n | bias | MAE | RMSE | MAE 60+ (n) | Spearman | top-20 actual | captain (raw) |');
    out.push('|---|---:|---:|---:|---:|---:|---:|---:|---|');
    for (const m of METHODS) {
      const x = r.methods[m];
      if (!x) { out.push(`| ${METHOD_LABELS[m]} | 0 | unavailable in this payload | | | | | | |`); continue; }
      out.push(`| ${METHOD_LABELS[m]} | ${x.n} | ${f(x.bias, 3)} | ${f(x.mae, 3)} | ${f(x.rmse, 3)} | ${f(x.mae60, 3)} (${x.n60}) | ${f(x.spearman, 3)} | ${f(x.top20)} | ${x.captainName || x.captainId}: ${x.captainPoints} |`);
    }
    out.push('', '| engine pStart bin | n | predicted | observed start rate |', '|---|---:|---:|---:|');
    for (const b of r.startCalibration) out.push(`| ${f(b.from, 1)} to ${f(b.to, 1)} | ${b.n} | ${f(b.predicted, 3)} | ${f(b.observed, 3)} |`);
    out.push('');
  }
  if (refused.length) {
    out.push('## Refused', '');
    for (const x of refused) out.push(`- ${x}`);
    out.push('');
  }
  out.push('## Drift', '');
  if (drift.length) for (const d of drift) out.push(`- DRIFT: ${d.message} (${d.gameweeks.join(', ')})`);
  else out.push(`- none: the engine has not trailed a reference on Spearman for ${DRIFT_RUN} consecutive gameweeks`);
  out.push('');
  return out.join('\n');
}
