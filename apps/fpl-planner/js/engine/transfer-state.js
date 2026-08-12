// The free-transfer allowance, as an explicit state machine over gameweeks.
//
// WHY THIS IS A MODULE AND NOT A NUMBER
//
// The allowance is not a quantity, it is a STATE that evolves from gameweek to
// gameweek, and it was previously reimplemented in five places that disagreed
// with each other and with the game:
//
//   - squad.js seeded a replay with 1 free transfer BEFORE gameweek 1 and then
//     added another for gameweek 2, so a manager who never transferred was told
//     he had 2 going into gameweek 2, 3 into gameweek 3, and 5 into gameweek 5.
//     Every gameweek of every historical replay ran one transfer rich.
//   - squad.js also handed a pre-season draft `rules.maxFreeTransfers`, which is
//     the CAP. Pre-season the answer is unlimited, and the first gameweek after
//     the deadline has exactly one.
//   - planner.js, transfers.js, chips.js and backtest.js each carried their own
//     `Math.min(cap, kept + 1)` and their own `max(0, count - free) * hitCost`.
//
// A test suite of 300+ scenarios never caught it because every one of them
// asserted that a SNAPSHOT was legal (0 <= ft <= 5, hits priced at 4) rather
// than that a SEQUENCE of gameweeks evolved correctly. Transitions are what this
// module owns, and tests/transfer-state.test.mjs walks them as seasons.
//
// THE RULES, as published at fantasy.premierleague.com/en/help/rules:
//
//   1. Until the first deadline of the season, transfers are UNLIMITED. There is
//      no count, and the cap is not a stand-in for one.
//   2. After that deadline, ONE free transfer arrives each gameweek.
//   3. An unused free transfer rolls over, to a maximum of
//      `rules.maxFreeTransfers` (five under the current game settings). Five is
//      a ceiling on what can be banked, never a starting value.
//   4. Each transfer beyond the free ones costs `rules.hitCost` points.
//   5. A wildcard or a free hit makes that gameweek's transfers unlimited and
//      free and does NOT spend what is banked. The usual +1 still arrives the
//      following gameweek.
//
// A manager who joins mid-season gets the same treatment: unlimited before the
// first deadline he plays, then one per gameweek. So the pre-season state is
// "before this manager's first deadline", not literally "before gameweek 1".
//
// THE UNLIMITED SENTINEL IS `Infinity`.
//
// It is not the cap, it is not null, and it is not a magic negative. Infinity is
// the only value that keeps every piece of allowance arithmetic correct without
// a special case at the call site: `Math.min(count, UNLIMITED)` is count and
// `Math.max(0, count - UNLIMITED)` is zero, which is exactly what unlimited
// means. `Number.isFinite` is the test for it, which is already how
// js/ui/plan-diff.js and js/ui/plan-model.js guard the value they render. The
// one place the sentinel must NOT be trusted to arithmetic is the rollover
// itself, because unlimited plus one is not unlimited, it is one; that
// transition lives in `advance` and nowhere else.

export const UNLIMITED = Infinity;

const PRESEASON = 'preseason';
const SEASON = 'season';

export function isUnlimited(state) {
  return !!state && state.phase === PRESEASON;
}

// The state a manager is in before his first deadline of the season: unlimited
// transfers, and no count to report.
export function initialTransferState({ gw = 1 } = {}) {
  return { phase: PRESEASON, gw, banked: UNLIMITED };
}

function seasonState(banked, rules, gw) {
  const cap = rules.maxFreeTransfers;
  return { phase: SEASON, gw, banked: Math.max(0, Math.min(cap, banked)) };
}

export function freeTransfersFor(state) {
  return state.banked;
}

// The state going into the NEXT gameweek, given what happened in this one.
//
// `recorded: false` means the gameweek is missing from the manager's history: a
// payload that has not caught up yet. It neither banks nor spends, because a
// gameweek we have no record of must never be allowed to INFLATE the count. The
// alternative the old code used, replaying an unknown gameweek as zero
// transfers, hands out a free transfer for a gameweek that may well have been
// spent.
export function advance(state, { gw, transfersMade = 0, chipPlayed = null, rules, recorded = true } = {}) {
  const at = gw === undefined || gw === null ? state.gw : gw;
  const nextGw = at === null || at === undefined ? null : at + 1;

  // Rule 1 into rule 2. Unlimited does not roll over: the first gameweek after
  // the deadline starts at exactly one however many transfers were made before
  // it, and a chip played in that gameweek changes nothing about that.
  if (state.phase === PRESEASON) return seasonState(1, rules, nextGw);

  if (!recorded) return { ...state, gw: nextGw };

  const free = chipPlayed === 'wildcard' || chipPlayed === 'freehit';
  const kept = free ? state.banked : Math.max(0, state.banked - transfersMade);
  return seasonState(kept + 1, rules, nextGw);
}

// Points charged for making `transfersMade` transfers in this state.
//
// `chipPlayed` is part of the question, not an afterthought: a wildcard or free
// hit week charges nothing whatever is banked, and a caller that has to
// remember that separately is a caller reimplementing this module.
export function hitCost(state, transfersMade, rules, chipPlayed = null) {
  return hitsFor(state, transfersMade, chipPlayed) * rules.hitCost;
}

function hitsFor(state, transfersMade, chipPlayed) {
  if (chipPlayed === 'wildcard' || chipPlayed === 'freehit') return 0;
  return Math.max(0, (transfersMade || 0) - state.banked);
}

// Everything a plan needs to say about its own transfers, from one place:
// what it spends, what is left, what it costs, and what next gameweek starts
// with. `freeTransfersAfter` is what remains BEFORE next gameweek's +1 arrives,
// which is why `freeTransfersNextGw` is a separate field and not a sum the UI
// is expected to do.
export function transferAccounting({ state, transfersMade = 0, chipPlayed = null, rules }) {
  const chipFree = chipPlayed === 'wildcard' || chipPlayed === 'freehit';
  const freeTransfersUsed = chipFree ? 0 : Math.min(transfersMade, state.banked);
  const hits = hitsFor(state, transfersMade, chipPlayed);
  return {
    freeTransfersUsed,
    freeTransfersAfter: chipFree ? state.banked : state.banked - freeTransfersUsed,
    hits,
    hitCostPoints: hits * rules.hitCost,
    freeTransfersNextGw: freeTransfersFor(advance(state, { transfersMade, chipPlayed, rules })),
  };
}

// A SquadState carries the state itself when it was built by this engine, and
// only a number when it came from somewhere else (a hand-built pre-season
// squad, a test fixture, a stored plan). Both are accepted, and the number is
// read back into a state rather than being arithmetic'd on directly.
export function transferStateOf(squadState, rules) {
  if (squadState && squadState.transferState) return squadState.transferState;
  const gw = squadState ? (squadState.gw ?? null) : null;
  const value = squadState ? squadState.freeTransfers : undefined;
  if (value === undefined || value === null) return seasonState(1, rules, gw);
  if (!Number.isFinite(value)) return initialTransferState({ gw });
  return seasonState(value, rules, gw);
}

// Replay a manager's season to find the state going into `upToGw`.
//
// The seed is the PRE-SEASON state at his first recorded gameweek, not one free
// transfer, because his first deadline is the one that starts the count. A
// gameweek inside the replayed range with no row is passed through unrecorded
// (see `advance`).
export function replayTransferState({ history, rules, upToGw }) {
  const rows = (history && history.current) || [];

  // With no history at all there is nothing to prove a transfer was banked. Up
  // to the first deadline that is genuinely unlimited; after it, one is the
  // floor the rules guarantee and the only honest answer.
  if (!rows.length) return upToGw <= 1 ? initialTransferState({ gw: upToGw }) : seasonState(1, rules, upToGw);

  const byEvent = new Map(rows.map(r => [r.event, r]));
  const chipByEvent = new Map(((history && history.chips) || []).map(c => [c.event, c.name]));
  const firstEvent = Math.min(...rows.map(r => r.event));

  let state = initialTransferState({ gw: firstEvent });
  for (let gw = firstEvent; gw < upToGw; gw++) {
    const row = byEvent.get(gw);
    state = advance(state, {
      gw,
      transfersMade: row ? (row.event_transfers || 0) : 0,
      chipPlayed: chipByEvent.get(gw) || null,
      rules,
      recorded: !!row,
    });
  }
  return state;
}

// Display only, called at the UI edge, and it takes the VALUE rather than the
// state so that a plan's `freeTransfersAfter` renders through the same
// function. The pre-season answer is a word, not a number, and the number it
// used to show was the cap.
export function formatFreeTransfers(value, { untilGw = null } = {}) {
  if (Number.isFinite(value)) return String(value);
  return untilGw ? `Unlimited until the GW${untilGw} deadline` : 'Unlimited';
}
