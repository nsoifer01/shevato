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
import { initialTransferState, replayTransferState, freeTransfersFor, transferAccounting, transferStateOf } from './transfer-state.js';

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

// Transfers already made for the gameweek being planned.
//
// `entry/{id}/event/{gw}/picks` is FROZEN at that gameweek's deadline: it is
// what the manager fielded, not what he owns now. The moment the gameweek ends
// he can transfer for the next one, and those moves appear immediately on
// `entry/{id}/transfers` and nowhere else. Reading only the picks therefore
// describes a squad he no longer has: the planner would hold a player he sold,
// miss the one he bought, recommend the move he had already made, and count a
// free transfer he had already spent.
//
// Applied in time order so a chain inside one window collapses correctly: A for
// B and then B for C leaves C in the squad and A the one who left.
export function pendingTransfers({ transfers, gw }) {
  return sortedTransfers(transfers).filter(t => t.event === gw);
}

function applyPending({ list, pending }) {
  const out = list.map(p => ({ ...p }));
  let moneyIn = 0;
  let moneyOut = 0;
  for (const t of pending) {
    const slot = out.find(p => p.element === t.element_out);
    // `element_out_cost` is the SELLING price FPL applied at the time, so the
    // bank moves by exactly what the manager received and paid. Nothing here
    // re-derives a selling price: the transfer row already states it.
    moneyIn += t.element_out_cost ?? 0;
    moneyOut += t.element_in_cost ?? 0;
    if (slot) {
      slot.element = t.element_in;
    } else {
      // The player leaving is not in the frozen fifteen, which happens when a
      // pending transfer sells someone an earlier pending transfer bought.
      // Sorting by time means that case is already handled above; landing here
      // means the payloads disagree, so the incoming player is added rather
      // than dropped and the value check downstream reports the mismatch.
      out.push({ element: t.element_in, position: out.length + 1, multiplier: 0, is_captain: false, is_vice_captain: false });
    }
  }
  return { picks: out, moneyIn, moneyOut, count: pending.length };
}

// The one money story a pre-season squad has, whichever way it was encoded.
//
// Before the first deadline the same fifteen exists in two SquadState shapes:
// a DRAFT holds no picks yet (the whole budget sits in the bank and the plan's
// moneyOut is what the fifteen costs), while a MANUAL squad, typed in or
// restored from a snapshot, holds the fifteen as picks with only the change
// left in the bank. Both are correct for the engine, but any screen that reads
// bankBeforeTenths as "the budget" is right for one encoding and nonsense for
// the other; that is how a restored squad came to read "It costs £0.0m of the
// £0.0m budget". Because a pre-season squad's value IS the budget, one formula
// covers both encodings, including a plan that reshapes the fifteen: what is
// left is the plan's closing bank, and the spend is everything else.
export function openingSquadMoney({ plan, rules }) {
  const budgetTenths = rules.budgetTenths;
  const remainingTenths = plan.bankAfterTenths;
  return { budgetTenths, spendTenths: budgetTenths - remainingTenths, remainingTenths };
}

// Whether this squad's picks describe a real LINEUP, not just a roster.
//
// Picks imported from FPL carry the slots FPL assigned (1-11 start, 12-15
// bench in auto-sub order) plus the captain flags. A manual squad's picks are
// synthetic: slots follow the order the fifteen was typed or restored in
// (position-ordered from a snapshot, goalkeepers first), every multiplier is
// 1 and nobody is flagged captain. Reading those slots as a lineup fielded
// two goalkeepers and called the user's own squad illegal. Anything that
// wants "the team as it stands" must check here first and fall back to the
// plan's arrangement when the answer is no.
export function picksCarryLineup(squadState) {
  return !!squadState
    && squadState.source !== 'manual'
    && (squadState.picks || []).length > 0;
}

// A degenerate season history: null, not an object, or no gameweek rows once
// the season has a gameweek on the board. `api.js` treats a 200 `null` body as
// a successful fetch, so this is the only place the gap can be seen. Read as
// "no chips used, one free transfer" it recommended a Wildcard to a manager
// who had already played his (2026-08-22 audit).
export function historyIsMissing(history, gameState) {
  if (!history || typeof history !== 'object') return true;
  if (!gameState || !gameState.seasonStarted) return false;
  return !Array.isArray(history.current) || history.current.length === 0;
}

export class UnknownPlayerError extends Error {
  constructor(ids) {
    super(`unknown_player: the squad names player id(s) ${ids.join(', ')} that the player list does not carry`);
    this.name = 'UnknownPlayerError';
    this.code = 'unknown_player';
    this.ids = ids;
  }
}

export function buildSquadState({ entry, history, transfers, picks, gameState, gw, source }) {
  const rules = gameState.rules;
  const targetGw = gw ?? gameState.nextEvent ?? gameState.currentEvent;
  const list = pickList(picks);
  const warnings = [];

  const historyMissing = historyIsMissing(history, gameState) && !!list;
  if (historyMissing) {
    warnings.push({
      code: 'history_missing',
      message: 'Fantasy Premier League returned no season history for this team, so the chips you have already '
        + 'played and your banked free transfers are unknown. No chip is recommended until it loads.',
    });
  }

  const base = {
    entryId: entry ? entry.id : null,
    entryName: entry ? entry.name : '',
    managerName: entry ? `${entry.player_first_name || ''} ${entry.player_last_name || ''}`.trim() : '',
    gw: targetGw,
    overallRank: (entry && entry.summary_overall_rank) ?? null,
    totalPoints: (entry && entry.summary_overall_points) ?? 0,
    chipsUsed: ((history && history.chips) || []).map(c => ({ name: c.name, event: c.event })),
    // Without a history nothing is known to be unused, and a chip that may
    // already have been played must never be offered.
    chipsAvailable: historyMissing ? [] : chipsRemaining({ history, rules, gw: targetGw }),
    historyMissing,
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

  // The squad the manager owns NOW: the frozen picks with any transfer already
  // made for the gameweek being planned applied on top.
  const pending = pendingTransfers({ transfers, gw: targetGw });
  const applied = applyPending({ list, pending });
  const effective = applied.picks;

  const purchases = reconstructPurchasePrices({ picks: effective, transfers, gameState });
  const entryHistory = (picks && picks.entry_history) || {};
  // The picks payload normally carries the bank and squad value alongside the
  // fifteen. If it ever arrives without them - which cannot be observed before
  // a gameweek has actually been scored - every affordability figure would read
  // as zero and the manager would be told he is broke. Say so instead of
  // planning on it silently.
  if (!picks || !picks.entry_history) {
    warnings.push({
      code: 'missing_entry_history',
      message: 'Fantasy Premier League returned your squad without its bank and squad value, so money figures may be wrong until it does. Transfers are still checked against your reconstructed selling prices.',
    });
  }

  // An empty squad in-season is not a pre-season draft: FPL served the picks
  // endpoint without the fifteen (observed shape: `picks: []` with an
  // entry_history block). Say so rather than offering to build an opening 15.
  if (list.length === 0 && gameState.seasonStarted) {
    warnings.push({
      code: 'empty_picks',
      message: 'Fantasy Premier League returned an empty squad for this gameweek, so the plan below is a fresh '
        + 'build from the full budget rather than advice about the team you own. Try again in a few minutes.',
    });
  }

  // A pick the player list does not know cannot be priced, positioned or
  // projected. It happens when fresh picks meet an older cached bootstrap (a
  // player registered since the copy was taken). Refuse by name rather than
  // letting a downstream `.position` read throw.
  const unknown = effective.map(p => p.element).filter(id => !gameState.players.has(id));
  if (unknown.length) throw new UnknownPlayerError(unknown);

  const built = effective.map(p => {
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

  // The bank moves with the transfers already made: FPL's frozen
  // `entry_history.bank` predates them.
  const bankTenths = (entryHistory.bank ?? 0) + applied.moneyIn - applied.moneyOut;
  // FPL's `entry_history.value` is the TOTAL: selling value of the 15 plus the
  // bank. Do not add the bank to it again downstream.
  const frozenValueTenths = entryHistory.value ?? 0;
  const sellingTotal = built.reduce((sum, p) => sum + p.sellingTenths, 0);
  // What the manager can spend TODAY, in every case: the fifteen at their
  // reconstructed selling prices, plus the bank.
  //
  // This used to fall back to FPL's own `value` whenever no transfer had been
  // made, and that number is a snapshot FROZEN at the gameweek deadline: it does
  // not track price moves after it (measured 2026-08-28, see FINDINGS "Fact 3").
  // One overnight fall was enough to make the header state 99.9 while the banner
  // directly below it named 99.8 and called the header's figure the wrong one.
  // Affordability was already computed from the reconstruction, so the fallback
  // only ever affected what was DISPLAYED - and it displayed the stale half.
  //
  // The one case with nothing to reconstruct FROM is an in-season payload that
  // carried no picks (`empty_picks`): there the frozen total is the only squad
  // figure that exists, and reporting the bank alone would say the manager owns
  // nothing.
  const squadValueTenths = built.length ? sellingTotal + bankTenths : frozenValueTenths;

  // The one arithmetic check that proves the purchase-price reconstruction was
  // right. It fails when a transfer is missing from the payload, and that has to
  // be visible: silently absorbing it would mean recommending transfers the
  // manager cannot afford.
  //
  // It is only meaningful against the FROZEN squad. Once a transfer has been
  // made for the gameweek being planned, FPL's `value` describes a squad that no
  // longer exists, so comparing against it would fire on every manager who had
  // simply used their transfer.
  //
  // COMPARE LIKE WITH LIKE. `value` is a snapshot taken at the frozen
  // gameweek's deadline (Fact 3), so the live reconstruction is guaranteed to
  // drift from it the instant any owned player changes price, and it fired on
  // that ordinary drift rather than on a fault: on 2026-09-01 one 0.1 fall put a
  // banner on the page for a squad whose arithmetic was perfect. Roll every
  // price back to the deadline with `costChangeEvent` first, and what is left
  // over is the part price movement does NOT explain, which is the only part
  // that ever meant anything.
  const deadlineTotal = built.reduce((sum, p) => {
    const player = gameState.players.get(p.playerId);
    const moved = player ? player.costChangeEvent : 0;
    const nowCost = player ? player.nowCost : 0;
    return sum + sellingPrice(p.purchaseTenths, nowCost - moved, rules);
  }, 0);
  // `costChangeEvent` measures movement since the CURRENT event's deadline, so
  // the roll-back only lines up when the frozen picks ARE the current event's.
  // Reading an older gameweek's picks (a rollover, a hand-passed payload) makes
  // it the wrong yardstick, and there the raw comparison is the honest one.
  const alignedToCurrentEvent = gameState.currentEvent !== null
    && gameState.currentEvent !== undefined
    && entryHistory.event === gameState.currentEvent;
  const reconciled = alignedToCurrentEvent
    ? deadlineTotal + bankTenths === frozenValueTenths
    : sellingTotal + bankTenths === frozenValueTenths;
  if (!applied.count && !reconciled) {
    warnings.push({
      code: 'value_mismatch',
      // Both to one decimal. Dividing by 10 alone printed "100.9 does not match
      // FPL's 101", one figure to a tenth and the other not, which read as two
      // different kinds of number rather than the same one twice.
      message: `Reconstructed squad value ${((sellingTotal + bankTenths) / 10).toFixed(1)} does not match FPL's ${(frozenValueTenths / 10).toFixed(1)}, and price changes since the deadline do not account for the difference. Selling prices may be off by it.`,
    });
  }

  // Free transfers, through the module that owns the arithmetic. The replay
  // gives the state at the start of the gameweek; the transfers already made
  // inside it are then spent against that state, so what reaches the planner is
  // what the manager has LEFT rather than what he started with.
  const replayed = replayTransferState({ history, rules, upToGw: targetGw });
  const acct = transferAccounting({ state: replayed, transfersMade: applied.count, chipPlayed: null, rules });
  const transferState = applied.count
    ? transferStateOf({ freeTransfers: acct.freeTransfersAfter, gw: targetGw }, rules)
    : replayed;

  return {
    ...base,
    picks: built,
    bankTenths,
    squadValueTenths,
    transferState,
    freeTransfers: freeTransfersFor(transferState),
    // What the manager has already done this window, so the UI can say so and
    // the planner is never asked to recommend a move that has been made.
    pendingTransfers: pending.map(t => ({
      out: t.element_out, in: t.element_in, event: t.event,
      outCost: t.element_out_cost, inCost: t.element_in_cost,
    })),
    hitsAlreadyTaken: acct.hits,
    source: source || 'picks',
  };
}
