// Pure readers over a PlanBundle. Everything the UI shows is derived here so
// the render modules stay layout-only, and so the rules that decide what the
// user is told (which action, which degraded state) are unit testable without
// a DOM.
//
// The one rule this file enforces: no sentence invents a reason. Rationale
// comes from `plan.explanation`; the helpers below only restate engine numbers.

import { chipLabel, plural } from './format.js';

// A PlanBundle as it crosses the worker boundary.
//
// structuredClone THROWS on a function, and ProjectionSet carries a `get()`
// convenience method, so the bundle has to be stripped before it is posted.
// Both sides of the runner (the worker and the inline fallback) go through this
// one function, so the UI sees the same shape however the plan was computed.
export function toWireBundle(bundle) {
  const p = bundle.projections;
  return {
    current: bundle.current,
    future: bundle.future,
    squadState: bundle.squadState,
    projections: {
      gwFrom: p.gwFrom,
      gwTo: p.gwTo,
      byPlayer: p.byPlayer,
      modelVersion: p.modelVersion,
      generatedAt: p.generatedAt,
      dataFetchedAt: p.dataFetchedAt,
    },
    dataStatus: bundle.dataStatus,
    validation: bundle.validation,
  };
}

// Which is why the UI reads `byPlayer` directly and never calls
// `projections.get`.
export function getProjection(projections, playerId, gw) {
  if (!projections) return null;
  const by = projections.byPlayer;
  if (!by) return null;
  const list = by instanceof Map ? by.get(playerId) : by[playerId];
  if (!Array.isArray(list)) return null;
  const idx = gw - projections.gwFrom;
  return list[idx] || null;
}

// "3-4-3" -> [1, 3, 4, 3]: the goalkeeper row is implicit in the FPL notation
// and explicit on the pitch. Any count of rows is accepted, so a formation the
// game invents later still renders.
export function formationRows(formation) {
  const parts = String(formation || '').split('-').map(n => parseInt(n, 10));
  if (!parts.length || parts.some(n => !Number.isInteger(n) || n < 0)) return null;
  return [1, ...parts];
}

// Split the XI into rows for the pitch. Players are bucketed by their real
// position rather than by their index in startingXI, so an XI in any order
// still lands in the right rows; the formation string decides how many rows
// there are and how many each holds.
export function pitchRows(startingXI, formation, positionOf) {
  const rows = formationRows(formation);
  if (!rows) return null;
  const buckets = new Map();
  for (const id of startingXI) {
    const pos = positionOf(id);
    if (!buckets.has(pos)) buckets.set(pos, []);
    buckets.get(pos).push(id);
  }
  return rows.map((count, i) => {
    const list = buckets.get(i + 1) || [];
    return list.slice(0, count);
  });
}

// Everything a player card needs, resolved once from the GameState so the
// render modules never reach into raw engine objects.
export function describePlayer(gameState, playerId) {
  const player = gameState.players instanceof Map
    ? gameState.players.get(playerId)
    : (gameState.players || {})[playerId];
  if (!player) return { id: playerId, name: `Player ${playerId}`, club: '', position: 0, positionShort: '', priceTenths: 0, status: 'a', news: '' };
  const team = gameState.teams instanceof Map ? gameState.teams.get(player.teamId) : null;
  const pos = gameState.rules.positions[player.position];
  return {
    id: playerId,
    name: player.webName,
    club: team ? team.shortName : '',
    clubName: team ? team.name : '',
    teamId: player.teamId,
    position: player.position,
    positionShort: pos ? pos.short : '',
    priceTenths: player.nowCost,
    status: player.status,
    chanceNext: player.chanceNext,
    news: player.news || '',
  };
}

// "BOU (H)" for a single fixture, both for a double, and an explicit phrase for
// a blank. Home and away come from the projection, which is the same fixture
// list the points were computed from.
export function fixtureLabel(projection, gameState) {
  if (!projection || !Array.isArray(projection.fixtures) || !projection.fixtures.length) return 'No fixture';
  return projection.fixtures.map(f => {
    const team = gameState.teams instanceof Map ? gameState.teams.get(f.opponentId) : null;
    return `${team ? team.shortName : f.opponentId} (${f.isHome ? 'H' : 'A'})`;
  }).join(', ');
}

// Availability, in the two states that change how a card is read. Anything the
// game calls unavailable is a hard flag; a doubt carries its own percentage
// when FPL published one.
export function availability(player) {
  if (!player) return null;
  const hard = { i: 'Injured', s: 'Suspended', u: 'Unavailable', n: 'Not in squad' };
  if (hard[player.status]) return { kind: 'out', label: hard[player.status], news: player.news || '' };
  if (player.status === 'd') {
    const pct = Number.isFinite(player.chanceNext) ? `${Math.round(player.chanceNext * 100)}%` : null;
    return { kind: 'doubt', label: pct ? `${pct} fit` : 'Doubt', news: player.news || '' };
  }
  return null;
}

export function moves(plan) {
  return {
    in: new Set(plan.transfersIn || []),
    out: new Set(plan.transfersOut || []),
  };
}

// The one-line action, in the user's words. The headline is the engine's
// (explanation.headline); the supporting sentence only names the players and
// counts the engine already decided.
export function actionText(plan, nameOf, { isDraft = false } = {}) {
  const ex = plan.explanation || {};
  const headline = ex.headline || fallbackHeadline(plan);
  const count = plan.transferCount || 0;

  // A draft has no squad behind it, so "0 transfers" is not the story: the
  // recommendation IS the fifteen.
  if (isDraft) {
    return { headline, sub: `A legal, affordable squad of ${plan.squad.length} for Gameweek ${plan.gw}, picked on projected points across the next ${plan.horizon} gameweeks.` };
  }

  if (plan.chip === 'freehit') {
    return { headline, sub: `A one week squad for Gameweek ${plan.gw}. Your real squad comes back next week, unchanged.` };
  }
  if (plan.chip === 'wildcard') {
    return { headline, sub: `${count} ${plural(count, 'change', 'changes')} to your squad, with no points cost.` };
  }
  if (count === 0) {
    // What next week STARTS with, which is what was banked plus the one that
    // arrives, capped. `freeTransfersAfter` is the count before that arrival, so
    // reporting it here was one short in every gameweek of the season.
    const next = plan.freeTransfersNextGw;
    const sub = Number.isFinite(next)
      ? `Bank this week's transfer. You go into next week with ${next} free ${plural(next, 'transfer')}.`
      : 'Bank this week\'s transfer.';
    return { headline, sub };
  }

  const pairs = pairUp(plan).map(p => `${nameOf(p.out)} out, ${nameOf(p.in)} in`).join('; ');
  const hit = plan.hits > 0 ? ` Taking ${plan.hits} ${plural(plan.hits, 'hit')}, ${plan.hitCostPoints} points.` : '';
  return { headline, sub: `${pairs}.${hit}` };
}

function fallbackHeadline(plan) {
  if (plan.chip) return `Play your ${chipLabel(plan.chip)}`;
  const n = plan.transferCount || 0;
  if (n === 0) return 'Roll your transfer';
  return `Make ${n} ${plural(n, 'transfer')}`;
}

// OUT and IN are two parallel arrays in the Plan; the UI wants them paired.
// transferReasons already carries the pairing when the engine computed one,
// because "which out funds which in" is an optimizer fact, not a UI guess.
export function pairUp(plan) {
  const reasons = (plan.explanation && plan.explanation.transferReasons) || [];
  if (reasons.length && reasons.length === (plan.transferCount || 0)) {
    return reasons.map(r => ({ out: r.out, in: r.in, gwGain: r.gwGain, horizonGain: r.horizonGain, reasons: r.reasons || [] }));
  }
  const outs = plan.transfersOut || [];
  const ins = plan.transfersIn || [];
  return outs.map((out, i) => {
    const r = reasons[i] || {};
    return { out, in: ins[i], gwGain: r.gwGain, horizonGain: r.horizonGain, reasons: r.reasons || [] };
  });
}

export function chipDecision(plan) {
  const reason = (plan.explanation && plan.explanation.chipReason) || null;
  if (plan.chip) {
    return { playing: true, label: chipLabel(plan.chip), reason };
  }
  return { playing: false, label: 'No chip', reason };
}

// How stale is too stale. Availability (injuries, suspensions, late news) is
// the input that decays fastest: a six hour old bootstrap can easily miss a
// press conference, and a plan built on it would be confidently wrong about
// who is fit. Past this age the plan is withheld rather than shown.
export const AVAILABILITY_MAX_AGE_SECONDS = 6 * 3600;

// What the UI is allowed to show given how the fetches went. Returns the exact
// wording inputs (which sources, why) so no caller has to invent copy.
export function assessData(dataStatus, { now = Date.now() } = {}) {
  const sources = (dataStatus && dataStatus.sources) || [];
  const failed = sources.filter(s => !s.ok);
  const stale = sources.filter(s => s.ok && s.stale);

  const core = sources.find(s => /bootstrap/.test(s.path || ''));
  const coreAge = core && Number.isFinite(core.ageSeconds) ? core.ageSeconds : null;
  const availabilityUnknown = !!core && (core.stale || !core.ok) && coreAge !== null && coreAge > AVAILABILITY_MAX_AGE_SECONDS;

  return {
    ok: failed.length === 0 && stale.length === 0,
    failed: failed.map(s => s.name),
    stale: stale.map(s => s.name),
    availabilityUnknown,
    // The single question the dashboard asks: may this plan be presented as a
    // recommendation at all?
    withholdPlan: availabilityUnknown,
    reason: availabilityUnknown
      ? 'Player availability could not be refreshed, so injuries and suspensions may be out of date.'
      : null,
    now,
  };
}

// A plan is only as current as the inputs it was built from. This fingerprint
// covers everything that would change the answer: the gameweek, exactly which
// players are held, the money and free transfers available, and each held
// player's price and availability status.
export function inputFingerprint(squadState, gameState, plan = null) {
  if (!squadState) return '';
  // A draft squad state holds no picks and banks the whole budget; the squad
  // and the money it describes only exist on the plan. Fingerprinting the raw
  // draft state made a built draft and its restored manual twin read as
  // different inputs, so every reload recorded a phantom new version. With
  // `plan` given (every post-plan call site), a draft fingerprints as the
  // squad the plan settled on, exactly what the restore will hold as picks.
  const isDraft = squadState.source === 'draft' && plan;
  const parts = [
    `gw:${squadState.gw}`,
    `bank:${isDraft ? plan.bankAfterTenths : squadState.bankTenths}`,
    `ft:${squadState.freeTransfers}`,
    `chips:${(squadState.chipsAvailable || []).slice().sort().join(',')}`,
  ];
  const ids = isDraft
    ? (plan.squad || []).slice().sort((a, b) => a - b)
    : (squadState.picks || []).map(p => p.playerId).slice().sort((a, b) => a - b);
  for (const id of ids) {
    const p = gameState && gameState.players ? readPlayer(gameState, id) : null;
    parts.push(p ? `${id}:${p.nowCost}:${p.status}` : `${id}`);
  }
  return parts.join('|');
}

function readPlayer(gameState, id) {
  const players = gameState.players;
  return players instanceof Map ? players.get(id) : players[id];
}

// Why a stored plan no longer applies. The wording is deliberately neutral: a
// user who ignored a recommendation is not corrected, their squad is simply
// the new input.
export function outdatedReason(oldFp, newFp) {
  if (!oldFp || oldFp === newFp) return null;
  const oldParts = oldFp.split('|');
  const newParts = newFp.split('|');
  const field = (parts, prefix) => (parts.find(p => p.startsWith(prefix)) || '');

  if (field(oldParts, 'gw:') !== field(newParts, 'gw:')) {
    return { code: 'new-gameweek', text: 'A new gameweek has started, so this plan was built for the previous deadline.' };
  }
  const oldIds = oldParts.filter(p => /^\d+/.test(p)).map(p => p.split(':')[0]).join(',');
  const newIds = newParts.filter(p => /^\d+/.test(p)).map(p => p.split(':')[0]).join(',');
  if (oldIds !== newIds) {
    return { code: 'squad-changed', text: 'Team updated. We\'ve rebuilt your plan based on your current squad.' };
  }
  if (field(oldParts, 'bank:') !== field(newParts, 'bank:') || field(oldParts, 'ft:') !== field(newParts, 'ft:')) {
    return { code: 'budget-changed', text: 'Your bank or free transfers changed since this plan was calculated.' };
  }
  return { code: 'players-changed', text: 'Prices or player availability changed since this plan was calculated.' };
}
