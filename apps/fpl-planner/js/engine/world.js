// THE WORLD A PLAN IS BUILT FROM, resolved once and shared.
//
// WHY THIS FILE EXISTS
//
// Until 2026-09-16 the decision "which season totals does this payload get
// projected from" lived inside `loadWorld` in app.js, next to the fetches. The
// historical replay could not call it, so it assembled its own game state with
// its own evidence rule: half of the previous season seeded into every total
// and never retired. Production did something else entirely (last season at
// full weight until every club had played three matches, then nothing), and
// every tuning experiment in experiments/registry.md was therefore measured in
// a regime production never runs. The xP audit of 2026-09-16 found the result:
// a nailed starter projected to play 64% to 76% of the time from gameweek 4 on,
// a state no replay had ever produced.
//
// So the resolution is a pure function here. `app.js` calls it with what it
// fetched and what it kept; `backtest.js` calls it with payloads it rebuilds
// from the archive for each deadline. The same function deciding for both is
// what makes a replay a measurement of the app rather than of a neighbour.

import { buildGameState } from './normalize.js';
import { resolveBaseline, validateOpeningBaseline } from './baseline.js';
import { seasonEvidence } from './minutes.js';

/**
 * Does this first reading of a payload need the shipped baseline at all?
 *
 * Since 2026-09-16 the previous season is a prior for the whole season, so the
 * answer is yes whenever the payload's own totals are not already last
 * season's. The asset pins its own season (`validateOpeningBaseline`), so a
 * future season fetches it once and refuses it. Sample data never touches a
 * baseline in either direction. The second argument is accepted for callers
 * written against the old signature and is no longer needed.
 */
export function openingBaselineApplies(gameState) {
  if (!gameState || gameState.sample) return false;
  return !payloadIsPreviousSeason(gameState);
}

/** The payload's element totals are the previous season's own. */
export function payloadIsPreviousSeason(gameState) {
  return seasonEvidence(gameState).kind === 'previous-season';
}

export { validateOpeningBaseline };

/**
 * Resolve the game state a plan is built from.
 *
 * `first` is `buildGameState(bootstrap, fixtures)` with no baseline, which the
 * caller already needs in hand (to keep a snapshot, and to decide whether to
 * fetch the shipped asset). `kept` is the browser's own snapshot and `shipped`
 * the committed asset, either of which may be null.
 *
 * Returns `{ gameState, resolution }`. `resolution` is null for sample data.
 */
export function resolveGameState(first, { bootstrap, fixtures, fetchedAt = null, kept = null, shipped = null } = {}) {
  if (!first || first.sample) return { gameState: first, resolution: null };
  const resolution = resolveBaseline(first, kept, {
    shipped,
    payloadIsPreviousSeason: payloadIsPreviousSeason(first),
  });
  const gameState = resolution.snapshot
    ? buildGameState(bootstrap, fixtures, {
      fetchedAt: fetchedAt || first.fetchedAt,
      baseline: resolution.snapshot,
      standIn: resolution.source === 'baseline',
    })
    : first;
  return { gameState, resolution };
}
