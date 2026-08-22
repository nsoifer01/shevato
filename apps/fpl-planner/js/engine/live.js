// LIVE GAMEWEEK SCORING: what the squad has ACTUALLY scored so far.
//
// WHY THIS FILE EXISTS
//
// `event/{gw}/live` was wired into the API layer and called from nowhere. The
// app therefore had no per-player points at all: the header could show a team
// total read off `entry_history`, and the pitch could show only expected
// points for a FUTURE gameweek, so a manager looking at fourteen points had no
// way to see where any of them came from.
//
// Actual points and expected points are different quantities and must never
// share a field or a label. Everything here is ACTUAL - what happened - and it
// is kept apart from the projections by name at every step.
//
// The arithmetic is FPL's, not ours:
//   - `picks[].multiplier` already encodes the armband and the bench: 0 for a
//     benched player, 1 for a starter, 2 for the captain, 3 under Triple
//     Captain, and 1 for everyone under Bench Boost.
//   - a player's points are `live.elements[].stats.total_points`, which INCLUDE
//     provisional bonus once FPL has computed it and change again when bonus is
//     confirmed.
//   - automatic substitutions are applied by FPL at gameweek end, not live, so
//     until then a benched player who came on is still worth zero to the team.
//
// So the team total is a sum, and it is checked against the official number
// rather than trusted: `reconciles` says whether our arithmetic agrees with
// FPL's, and any disagreement is surfaced instead of hidden.

import { fixturePhase, FIXTURE_PHASE } from './lifecycle.js';

/** elementId -> live stats, from an `event/{gw}/live` payload. */
export function buildLiveStats(payload) {
  const byId = new Map();
  const elements = (payload && payload.elements) || [];
  for (const e of elements) {
    if (!e || e.id == null) continue;
    byId.set(e.id, e.stats || {});
  }
  return byId;
}

/**
 * The fixture a player's club is involved in for a gameweek, and its phase.
 * A club with no fixture that gameweek is blank; a club with two is a double,
 * and the LEAST advanced phase is the honest answer for "has he finished".
 */
export function playerFixturePhase(gameState, player, gw) {
  if (!player) return { phase: FIXTURE_PHASE.UPCOMING, fixtures: [] };
  const fixtures = gameState.fixtures.filter(
    f => f.event === gw && (f.teamH === player.teamId || f.teamA === player.teamId),
  );
  if (!fixtures.length) return { phase: null, fixtures: [] };   // blank gameweek
  const order = [FIXTURE_PHASE.UPCOMING, FIXTURE_PHASE.LIVE, FIXTURE_PHASE.PROVISIONAL, FIXTURE_PHASE.FINAL];
  let least = FIXTURE_PHASE.FINAL;
  for (const f of fixtures) {
    const p = fixturePhase(f);
    if (order.indexOf(p) < order.indexOf(least)) least = p;
  }
  return { phase: least, fixtures };
}

/**
 * Score a squad's gameweek from the live payload.
 *
 * @param {object} input
 * @param {object} input.picks      the raw `entry/{id}/event/{gw}/picks` payload
 * @param {Map}    input.live       from buildLiveStats()
 * @param {object} input.gameState
 * @param {number} input.gw
 */
export function scoreLiveSquad({ picks, live, gameState, gw }) {
  const rows = [];
  const list = (picks && picks.picks) || [];
  const stats = live || new Map();

  let startersTotal = 0;
  let benchTotal = 0;

  for (const pick of list) {
    const player = gameState.players.get(pick.element) || null;
    const s = stats.get(pick.element) || null;
    const raw = s && Number.isFinite(s.total_points) ? s.total_points : null;
    const minutes = s && Number.isFinite(s.minutes) ? s.minutes : null;
    const { phase, fixtures } = playerFixturePhase(gameState, player, gw);
    const onBench = pick.multiplier === 0;
    // Points as they COUNT for the team: the armband and the bench are already
    // in the multiplier, so this is the contribution, not the player's score.
    const counted = raw === null ? null : raw * pick.multiplier;
    if (counted !== null) {
      if (onBench) benchTotal += raw;          // bench points are raw, never multiplied
      else startersTotal += counted;
    }
    rows.push({
      id: pick.element,
      position: pick.position,
      onBench,
      multiplier: pick.multiplier,
      isCaptain: !!pick.is_captain,
      isViceCaptain: !!pick.is_vice_captain,
      // The player's own score, before the armband.
      points: raw,
      // What he contributed to the team total.
      contributed: onBench ? 0 : counted,
      minutes,
      // null means "no data yet", which is NOT the same as zero and must never
      // be rendered as a score.
      hasPlayed: minutes !== null && minutes > 0,
      fixturePhase: phase,
      fixtureCount: fixtures.length,
      blank: phase === null,
    });
  }

  const official = picks && picks.entry_history && Number.isFinite(picks.entry_history.points)
    ? picks.entry_history.points
    : null;
  // FPL's number is net of transfer hits; ours is the raw sum of what the
  // eleven scored, so the hit is the documented difference between them.
  const hit = picks && picks.entry_history && Number.isFinite(picks.entry_history.event_transfers_cost)
    ? picks.entry_history.event_transfers_cost
    : 0;
  const computed = startersTotal - hit;

  return {
    gw,
    rows,
    startersTotal,
    benchTotal,
    hit,
    computed,
    official,
    // Proven, not assumed. A mismatch means our reading of FPL's scoring is
    // wrong somewhere and the UI must say so rather than show a number that
    // disagrees with the game.
    reconciles: official === null ? null : computed === official,
    autoSubs: (picks && picks.automatic_subs) || [],
    activeChip: (picks && picks.active_chip) || null,
  };
}
