// What changed, and why.
//
// A recommendation that quietly turns into a different recommendation between
// two visits is the fastest way to lose a user's trust. This module answers the
// question they will actually ask: it was "roll", now it is "sell Garner, buy
// Saka", what moved?
//
// THE RULE: nothing here narrates. Every sentence is produced by comparing two
// stored snapshots field by field and printing the field that moved with the
// amount it moved by. If no field moved, this module says so rather than
// manufacturing a difference, because a plausible-sounding invented reason is
// worse than "nothing changed".
//
// WHY SNAPSHOTS AND NOT A RECOMPUTE. The previous plan's world is gone by the
// time the next one is built: prices have moved, the injury list has moved, the
// projections have moved. The only way to cite "Garner's projection fell 1.8
// points" honestly is to have written down what it was. `planInputs` is that
// written-down copy, and it is deliberately small because it rides in the
// synced plan history.

import { formatMoney, chipLabel, plural, xp } from './format.js';
import { getProjection, describePlayer } from './plan-model.js';
import { recommendationLine, reasonLabel } from './history.js';

export const DIFF_PARAMS = Object.freeze({
  // A projection that moved by less than this is model noise between two runs,
  // not news. One tenth of a goal contribution is roughly half a point.
  projectionMovePoints: 0.5,
  // Enough to explain a change without turning into a changelog.
  maxReasons: 4,
});

// Short keys because this object is stored once per plan version, five versions
// per gameweek, for eight gameweeks, inside a synced document.
//   p price in tenths   s status   c chance of playing next   x projected points
const STATUS_WORD = {
  a: 'available',
  d: 'a doubt',
  i: 'injured',
  s: 'suspended',
  u: 'unavailable',
  n: 'out of the squad',
};
const HARD = new Set(['i', 's', 'u', 'n']);

function readPlayer(gameState, id) {
  if (!gameState || !gameState.players) return null;
  return gameState.players instanceof Map ? gameState.players.get(id) : gameState.players[id];
}

/**
 * The inputs a plan was built from, small enough to store next to it.
 * Only the players either plan could name are kept: the fifteen it holds plus
 * anyone it moves.
 */
export function planInputs({ plan, projections, squadState, gameState, dataStatus = null }) {
  const players = {};
  const ids = new Set([
    ...(plan.squad || []),
    ...(plan.transfersOut || []),
    ...(plan.transfersIn || []),
  ]);
  for (const id of ids) {
    const player = readPlayer(gameState, id);
    const row = getProjection(projections, id, plan.gw);
    players[id] = {
      p: player ? player.nowCost : null,
      s: player ? player.status : null,
      c: player && Number.isFinite(player.chanceNext) ? player.chanceNext : null,
      x: row && Number.isFinite(row.xPoints) ? Math.round(row.xPoints * 10) / 10 : null,
    };
  }

  return {
    bank: squadState ? squadState.bankTenths : null,
    ft: squadState ? squadState.freeTransfers : null,
    chips: squadState ? (squadState.chipsAvailable || []).slice().sort() : [],
    horizon: dataStatus ? dataStatus.horizon : null,
    risk: dataStatus ? dataStatus.risk : null,
    players,
  };
}

// The decisions that make one recommendation a different recommendation. Bench
// order and formation move on their own from week to week without the advice
// changing, so they are not in here.
export function actionKey(plan) {
  if (!plan) return '';
  const sorted = (list) => (list || []).slice().sort((a, b) => a - b).join(',');
  return [
    plan.chip || 'none',
    sorted(plan.transfersOut),
    sorted(plan.transfersIn),
    plan.captain,
    plan.viceCaptain,
    plan.hits || 0,
  ].join('|');
}

/* ----------------------------------------------------------------- reasons */

function nameOf(gameState, id) {
  return gameState ? describePlayer(gameState, Number(id)).name : `player ${id}`;
}

// Which players are worth reporting a projection or price move for: the ones
// either version's recommendation actually names. A price list for all fifteen
// would bury the two that mattered.
function namedPlayers(prev, next) {
  const ids = new Set();
  for (const version of [prev, next]) {
    const plan = version && version.plan;
    if (!plan) continue;
    for (const id of plan.transfersOut || []) ids.add(String(id));
    for (const id of plan.transfersIn || []) ids.add(String(id));
    if (plan.captain) ids.add(String(plan.captain));
    if (plan.viceCaptain) ids.add(String(plan.viceCaptain));
  }
  return ids;
}

function availabilityReasons(before, after, gameState) {
  const out = [];
  for (const id of Object.keys(after.players || {})) {
    const was = (before.players || {})[id];
    const now = after.players[id];
    if (!was || !now) continue;
    const name = nameOf(gameState, id);

    if (was.s !== now.s) {
      if (HARD.has(now.s)) {
        out.push({ code: 'now_flagged', id: Number(id), text: `${name} is now flagged ${STATUS_WORD[now.s] || now.s}.` });
      } else if (now.s === 'd') {
        out.push({ code: 'now_doubt', id: Number(id), text: `${name} now carries a fitness doubt.` });
      } else if (HARD.has(was.s) || was.s === 'd') {
        out.push({ code: 'now_fit', id: Number(id), text: `${name} is available again.` });
      }
      continue;
    }
    if (Number.isFinite(was.c) && Number.isFinite(now.c) && was.c !== now.c) {
      out.push({
        code: 'chance_moved',
        id: Number(id),
        text: `${name}'s chance of playing moved from ${Math.round(was.c * 100)}% to ${Math.round(now.c * 100)}%.`,
      });
    }
  }
  return out;
}

function projectionReasons(before, after, gameState, named) {
  const out = [];
  for (const id of named) {
    const was = (before.players || {})[id];
    const now = (after.players || {})[id];
    if (!was || !now || !Number.isFinite(was.x) || !Number.isFinite(now.x)) continue;
    const delta = now.x - was.x;
    if (Math.abs(delta) < DIFF_PARAMS.projectionMovePoints) continue;
    out.push({
      code: 'projection_moved',
      id: Number(id),
      text: `${nameOf(gameState, id)}'s projection ${delta > 0 ? 'rose' : 'fell'} ${xp(Math.abs(delta))} points, from ${xp(was.x)} to ${xp(now.x)}.`,
    });
  }
  return out.sort((a, b) => a.id - b.id);
}

function priceReasons(before, after, gameState, named) {
  const out = [];
  for (const id of named) {
    const was = (before.players || {})[id];
    const now = (after.players || {})[id];
    if (!was || !now || !Number.isFinite(was.p) || !Number.isFinite(now.p) || was.p === now.p) continue;
    out.push({
      code: 'price_moved',
      id: Number(id),
      text: `${nameOf(gameState, id)} ${now.p > was.p ? 'rose' : 'fell'} ${formatMoney(Math.abs(now.p - was.p))} to ${formatMoney(now.p)}.`,
    });
  }
  return out.sort((a, b) => a.id - b.id);
}

function budgetReasons(before, after) {
  const out = [];
  if (Number.isFinite(before.bank) && Number.isFinite(after.bank) && before.bank !== after.bank) {
    out.push({
      code: 'bank_moved',
      text: `Your bank ${after.bank > before.bank ? 'rose' : 'fell'} from ${formatMoney(before.bank)} to ${formatMoney(after.bank)}.`,
    });
  }
  if (Number.isFinite(before.ft) && Number.isFinite(after.ft) && before.ft !== after.ft) {
    out.push({
      code: 'free_transfers_moved',
      text: `You have ${after.ft} free ${plural(after.ft, 'transfer')} now, ${after.ft > before.ft ? 'up' : 'down'} from ${before.ft}.`,
    });
  }
  return out;
}

function chipReasons(before, after) {
  const was = new Set(before.chips || []);
  const now = new Set(after.chips || []);
  const out = [];
  for (const chip of was) {
    if (!now.has(chip)) out.push({ code: 'chip_spent', text: `Your ${chipLabel(chip)} is no longer available.` });
  }
  for (const chip of now) {
    if (!was.has(chip)) out.push({ code: 'chip_returned', text: `Your ${chipLabel(chip)} is available again.` });
  }
  return out;
}

// A settings change is a field that moved just as much as a price is, and it is
// the only thing that can rewrite a plan while the Fantasy Premier League data
// stands still.
function settingsReasons(before, after) {
  const out = [];
  if (Number.isFinite(before.horizon) && Number.isFinite(after.horizon) && before.horizon !== after.horizon) {
    out.push({ code: 'horizon_changed', text: `You changed the horizon from ${before.horizon} to ${after.horizon} gameweeks.` });
  }
  if (before.risk && after.risk && before.risk !== after.risk) {
    out.push({ code: 'risk_changed', text: `You changed the risk profile from ${before.risk} to ${after.risk}.` });
  }
  return out;
}

/* -------------------------------------------------------------------- diff */

/**
 * Compare two stored plan versions for the same gameweek.
 *
 * @param {object} previous a stored version: { plan, inputs, reason, computedAt }
 * @param {object} next     the version just calculated, same shape
 * @returns {{changed, headline, previousLine, currentLine, reasons, why} | null}
 */
export function diffPlanVersions(previous, next, { gameState = null } = {}) {
  if (!previous || !next || !previous.plan || !next.plan) return null;

  const changed = actionKey(previous.plan) !== actionKey(next.plan);
  const before = previous.inputs || null;
  const after = next.inputs || null;

  let reasons = [];
  if (before && after) {
    const named = namedPlayers(previous, next);
    reasons = [
      ...availabilityReasons(before, after, gameState),
      ...projectionReasons(before, after, gameState, named),
      ...priceReasons(before, after, gameState, named),
      ...budgetReasons(before, after),
      ...chipReasons(before, after),
      ...settingsReasons(before, after),
    ].slice(0, DIFF_PARAMS.maxReasons);
  }

  const previousLine = recommendationLine(previous, gameState);
  const currentLine = recommendationLine(next, gameState);

  // The recommendation moved but nothing we stored can account for it. Say
  // which recalculation asked for it rather than inventing a cause.
  const fallback = changed && !reasons.length
    ? [{ code: 'recalculated', text: `${reasonLabel(next.reason)}.` }]
    : [];
  const stated = reasons.length ? reasons : fallback;

  return {
    changed,
    headline: changed ? 'Plan updated' : 'Plan unchanged',
    previousLine,
    currentLine,
    reasons: stated,
    why: stated.length
      ? stated.map(r => r.text).join(' ')
      : 'Nothing that feeds the plan has moved since it was last calculated.',
  };
}
