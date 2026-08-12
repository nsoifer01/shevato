// Entry data -> SquadState: what the manager actually owns, what each player is
// worth if sold TODAY, how much money is really available, how many free
// transfers are banked, and which chips are still in hand.
//
// This module is the difference between a recommendation that can be executed
// and one that cannot. `now_cost` is the WRONG number to spend against: FPL
// takes half the profit on any player who has risen since you bought him, so a
// squad valued at its current prices can be a full million richer than the one
// the manager can actually transact with.
//
// Everything here is pure and works in integer tenths.

import { sellingPrice, chipAvailableAt } from './rules.js';
import { initialTransferState, replayTransferState, freeTransfersFor } from './transfer-state.js';

// Accepts either the raw `entry/{id}/event/{gw}/picks/` payload or the bare
// picks array, because both shapes turn up at call sites.
function pickList(picks) {
  if (!picks) return null;
  if (Array.isArray(picks)) return picks;
  return Array.isArray(picks.picks) ? picks.picks : null;
}

// Ascending replay order. FPL serves transfers newest-first, and two transfers
// inside one gameweek are only separable by their timestamp.
function sortedTransfers(transfers) {
  return (transfers || []).slice().sort((a, b) => {
    if (a.event !== b.event) return a.event - b.event;
    return String(a.time || '').localeCompare(String(b.time || ''));
  });
}

// The price the manager PAID for each held player.
//
// Rule 1: the `element_in_cost` of the most recent transfer that brought him
// in. A player bought at 7.0, sold, and re-bought at 7.6 was paid 7.6 for.
// Rule 2 (never transferred in, i.e. an original pick): his price when the
// squad was created, recovered as nowCost - costChangeStart. That is exact for
// a squad created before GW1, which is every squad that still holds an original
// pick, and it is the closest the public API gets for one created later.
export function reconstructPurchasePrices({ picks, transfers, gameState }) {
  const list = pickList(picks) || [];
  const latestIn = new Map();
  for (const t of sortedTransfers(transfers)) latestIn.set(t.element_in, t.element_in_cost);

  const out = new Map();
  for (const p of list) {
    const id = p.element;
    if (latestIn.has(id)) {
      out.set(id, latestIn.get(id));
      continue;
    }
    const player = gameState.players.get(id);
    out.set(id, player ? player.nowCost - player.costChangeStart : 0);
  }
  return out;
}

// How many free transfers are banked going into `upToGw`, replayed from the
// manager's own history. Never assume 1 and never assume the cap: the rollover
// arithmetic, the pre-season case and the chip weeks all live in
// transfer-state.js, which is the only module allowed to know them.
export function computeFreeTransfers({ history, rules, upToGw }) {
  return freeTransfersFor(replayTransferState({ history, rules, upToGw }));
}

// Chip names still playable in `gw`, honouring each chip's half-season window
// and the ones already spent.
export function chipsRemaining({ history, rules, gw }) {
  const used = ((history && history.chips) || []).map(c => ({ name: c.name, event: c.event }));
  const names = [...new Set(rules.chips.map(c => c.name))];
  return names.filter(name => chipAvailableAt(rules, name, gw, used));
}

export function buildSquadState({ entry, history, transfers, picks, gameState, gw, source }) {
  const rules = gameState.rules;
  const targetGw = gw ?? gameState.nextEvent ?? gameState.currentEvent;
  const list = pickList(picks);
  const warnings = [];

  const base = {
    entryId: entry ? entry.id : null,
    entryName: entry ? entry.name : '',
    managerName: entry ? `${entry.player_first_name || ''} ${entry.player_last_name || ''}`.trim() : '',
    gw: targetGw,
    overallRank: (entry && entry.summary_overall_rank) ?? null,
    totalPoints: (entry && entry.summary_overall_points) ?? 0,
    chipsUsed: ((history && history.chips) || []).map(c => ({ name: c.name, event: c.event })),
    chipsAvailable: chipsRemaining({ history, rules, gw: targetGw }),
    asOf: gameState.fetchedAt,
    warnings,
  };

  // PRE-SEASON / NO PICKS. `entry/{id}/event/{gw}/picks/` 404s for every
  // gameweek until GW1 goes live, which is not a failure: the manager simply
  // has no squad yet. The planner builds one from scratch instead.
  if (!list) {
    // Before the first deadline the allowance is UNLIMITED, which is a state and
    // not a number. It is emphatically not `maxFreeTransfers`: that is the cap
    // on what may be banked once the season has started, and reporting it here
    // told every manager he had five when the true answers are "as many as you
    // like" now and "one" in the first gameweek after the deadline.
    const transferState = initialTransferState({ gw: targetGw });
    return {
      ...base,
      picks: [],
      bankTenths: rules.budgetTenths,
      squadValueTenths: rules.budgetTenths,
      transferState,
      freeTransfers: freeTransfersFor(transferState),
      source: source || 'draft',
    };
  }

  const purchases = reconstructPurchasePrices({ picks, transfers, gameState });
  const entryHistory = (picks && picks.entry_history) || {};

  const built = list.map(p => {
    const player = gameState.players.get(p.element);
    const nowCost = player ? player.nowCost : 0;
    const purchaseTenths = purchases.get(p.element) ?? nowCost;
    return {
      playerId: p.element,
      slot: p.position,
      isCaptain: !!p.is_captain,
      isViceCaptain: !!p.is_vice_captain,
      multiplier: p.multiplier,
      purchaseTenths,
      sellingTenths: sellingPrice(purchaseTenths, nowCost, rules),
    };
  });

  const bankTenths = entryHistory.bank ?? 0;
  // FPL's `entry_history.value` is the TOTAL: selling value of the 15 plus the
  // bank. Do not add the bank to it again downstream.
  const squadValueTenths = entryHistory.value ?? 0;
  const sellingTotal = built.reduce((sum, p) => sum + p.sellingTenths, 0);

  // The one arithmetic check that proves the purchase-price reconstruction was
  // right. It fails when a transfer is missing from the payload or a player was
  // price-changed between the two fetches, and that has to be visible: silently
  // absorbing it would mean recommending transfers the manager cannot afford.
  if (sellingTotal + bankTenths !== squadValueTenths) {
    warnings.push({
      code: 'value_mismatch',
      message: `Reconstructed squad value ${(sellingTotal + bankTenths) / 10} does not match FPL's ${squadValueTenths / 10}. Selling prices may be off by the difference.`,
    });
  }

  const transferState = replayTransferState({ history, rules, upToGw: targetGw });

  return {
    ...base,
    picks: built,
    bankTenths,
    squadValueTenths,
    transferState,
    freeTransfers: freeTransfersFor(transferState),
    source: source || 'picks',
  };
}
