// FPL price-change predictions: the raw official fields turned into one safe
// display model, in the ONE place that is allowed to know the arithmetic.
//
// WHERE THE DATA COMES FROM. Fantasy Premier League publishes its own
// short-term price-change predictions inside `bootstrap-static`, per player.
// The app already fetches and caches that payload for everything else, so this
// feature adds no endpoint, no third party and no new failure surface.
// LiveFPL and the other public predictors were measured against these fields
// on 2026-09-05 and are re-serving them (median absolute difference 0.00
// percentage points over all 653 players), so there is nothing to gain by
// calling one.
//
// WHAT IS INFERRED RATHER THAN DOCUMENTED. FPL publishes no schema for any of
// this, and three things below are read off the data rather than promised by
// an API:
//
//   1. THE THRESHOLD, and this one is now MEASURED rather than guessed.
//      `price_change_percent` is signed progress towards a change, and 100 is
//      treated as the crossing point. Verified against a full change cycle on
//      2026-09-05: the offset-0 projections read at 21:30 UTC predicted exactly
//      2 rises and 12 falls, and comparing `now_cost` after the 23:00 window
//      found exactly those 14 moves, with no misses and no false positives
//      (14/14). It is a constant here with this comment, never a literal in a
//      caller.
//   2. THE LIKELIHOOD SCALE. `likelihood` is an integer in -5..+5 whose sign
//      tracks the direction. It is a CONFIDENCE TIER, not a probability, and
//      nothing in this module or above it may render it as a percentage. The
//      three tiers below are a presentation choice over that integer.
//   3. THE OFFSET CALENDAR. `offset` 0/1/2 are consecutive price-change
//      windows. Which wall-clock moment each one is comes from
//      `game_config.settings.price_change_deadlines`, never from assuming a
//      time of day.
//
// WHAT IS DELIBERATELY NOT USED. `price_change_hourly_rate` is carried by the
// payload and its units were measured on 2026-09-05 across a 2.2 hour window:
// dividing it by roughly 2270 gives percentage points per hour (p25-p75 of
// 2123-2430 over the 32 players whose rate was large enough to clear the 0.1
// reporting quantum). That is only a ballpark, the window crossed a change
// event, and NOTHING here uses it: `price_change_projections` is first-party,
// carries its own confidence, and answers the question directly, so
// extrapolating from a rate we fitted ourselves would be strictly worse.
// normalize.js does not carry the field at all, so nothing can start.
//
// THE HORIZON IS THREE DAYS, NOT FIVE GAMEWEEKS. FPL projects offsets 0, 1 and
// 2 and no further. Nothing in this module invents a price beyond them.

// Progress at which a price actually moves. Inferred; see (1) above.
export const PRICE_CHANGE_THRESHOLD = 100;

// Progress at which a player counts as NEAR a change without crossing it. Unlike
// the threshold this is a PRESENTATION choice, not a fact about the game:
// nothing moves at 90. It exists because the threshold is a hard edge, and on
// 2026-09-15 Foden, suspended and sold by 97k managers, was projected at -99.7%
// by the last window before the GW5 deadline while his transfer card looked
// exactly like a player drifting at -3%. On that day's payload 48 of 659
// players crossed 100 in some window, and a further 18 peaked in [90, 100), 50
// in [80, 100) and 155 in [50, 100), so 90 adds a handful rather than a crowd.
// A near approach is shown on the transfer card and never scored: see `near` in
// readPriceChange, and priceUrgency.
export const PRICE_CHANGE_NEAR = 90;

// |likelihood| -> tier. Inferred; see (2) above. Zero is "no signal" and is not
// a tier, so it renders as nothing rather than as a weak claim.
const TIERS = [
  { min: 5, key: 'strong', label: 'Strong signal' },
  { min: 3, key: 'moderate', label: 'Moderate signal' },
  { min: 1, key: 'slight', label: 'Slight signal' },
];

// offset -> how the timing reads. Only these three exist upstream.
const TIMING = {
  0: { key: 'tonight', label: 'tonight' },
  1: { key: 'tomorrow', label: 'tomorrow' },
  2: { key: 'in-2-days', label: 'in 2 days' },
};

export function likelihoodTier(likelihood) {
  if (!Number.isFinite(likelihood)) return null;
  const mag = Math.abs(likelihood);
  for (const t of TIERS) if (mag >= t.min) return t;
  return null;
}

// The empty model. Every caller can read every field off this without a guard,
// which is what keeps `?.` chains and "if data exists" branches out of the UI.
function noSignal(extra = {}) {
  return {
    available: false,
    direction: 'none',
    offset: null,
    timing: null,
    timingLabel: null,
    projectedPercent: null,
    progressPercent: null,
    likelihood: null,
    tier: null,
    tierLabel: null,
    locked: false,
    lockedUntil: null,
    calibrating: false,
    changeAt: null,
    // True only when there is a movement worth putting on screen. A player with
    // data but nothing projected to cross must NOT get a badge, or every one of
    // 600 players gets one and the badge stops meaning anything.
    displayable: false,
    // The closest approach that reaches PRICE_CHANGE_NEAR without crossing, as
    // { direction, offset, timing, timingLabel, projectedPercent, changeAt }, or
    // null. It never sets `direction` or `displayable`, so nothing that decides
    // or badges by default can mistake it for a projected move.
    near: null,
    ...extra,
  };
}

// The price-change windows still ahead of `now`, oldest first, so index i is
// projection offset i. Missing or malformed deadlines yield an empty list and
// the model then falls back to offset-relative wording rather than inventing a
// time of day.
export function upcomingDeadlines(deadlines, now) {
  if (!Array.isArray(deadlines)) return [];
  const t = Number.isFinite(now) ? now : Date.parse(String(now));
  return deadlines
    .map(d => Date.parse(String(d)))
    .filter(ms => Number.isFinite(ms) && (!Number.isFinite(t) || ms > t))
    .sort((a, b) => a - b)
    .map(ms => new Date(ms).toISOString());
}

// The sub-threshold window that comes CLOSEST to a change, or null. Closest
// rather than earliest, because "near" is a claim about how close: a player at
// 91% tonight and 99% in two days is nearest in two days. `reachable` is the
// same lock gate a crossing passes, since "near a rise tonight" under a lock
// that covers tonight is just as impossible as a rise tonight.
function nearApproach(projections, windows, reachable) {
  let best = null;
  for (const p of projections) {
    if (!Number.isFinite(p.projectedPercent)) continue;
    const mag = Math.abs(p.projectedPercent);
    if (mag < PRICE_CHANGE_NEAR || mag >= PRICE_CHANGE_THRESHOLD) continue;
    const changeAt = windows[p.offset] || null;
    if (!reachable(changeAt)) continue;
    // Strictly closer only, so equal approaches keep the earliest window.
    if (best && mag <= Math.abs(best.projectedPercent)) continue;
    best = { ...p, changeAt };
  }
  if (!best) return null;

  const timing = TIMING[best.offset] || null;
  return {
    direction: best.projectedPercent > 0 ? 'rise' : 'fall',
    offset: best.offset,
    timing: timing ? timing.key : null,
    timingLabel: timing ? timing.label : null,
    projectedPercent: best.projectedPercent,
    changeAt: best.changeAt,
  };
}

/**
 * Turn a normalized player's `priceChange` into the display model.
 *
 * `now` and `deadlines` are injected rather than read from the clock or a
 * global so every state below is reachable from a test without faking time.
 */
export function readPriceChange(player, { now = Date.now(), deadlines = [] } = {}) {
  const pc = player && player.priceChange;
  if (!pc) return noSignal();

  const nowMs = Number.isFinite(now) ? now : Date.parse(String(now));
  const windows = upcomingDeadlines(deadlines, nowMs);

  const lockedUntil = pc.lockedUntil || null;
  const lockMs = lockedUntil ? Date.parse(lockedUntil) : NaN;
  // A lock only matters while it is still in the future. An expired one is not
  // a state, it is history.
  const lockActive = Number.isFinite(lockMs) && Number.isFinite(nowMs) && lockMs > nowMs;

  const base = {
    available: true,
    progressPercent: pc.progressPercent,
    locked: lockActive,
    lockedUntil: lockActive ? lockedUntil : null,
    calibrating: !!pc.calibrating,
  };

  // A player FPL has locked cannot move again until the lock expires, so any
  // window that closes at or before the lock is not a possible change and
  // claiming one would be the app promising something the game forbids.
  const reachable = (changeAt) => {
    if (!lockActive) return true;
    if (!changeAt) return false;            // unknown window under a live lock: never claim it
    return Date.parse(changeAt) > lockMs;
  };

  // The EARLIEST offset whose projection crosses the threshold is the one that
  // decides urgency: a rise two days out is not a reason to act tonight.
  let hit = null;
  for (const p of pc.projections) {
    if (!Number.isFinite(p.projectedPercent)) continue;
    if (Math.abs(p.projectedPercent) < PRICE_CHANGE_THRESHOLD) continue;

    const changeAt = windows[p.offset] || null;
    if (!reachable(changeAt)) continue;

    hit = { ...p, changeAt };
    break;
  }

  if (!hit) {
    // Distinguish "locked out of a move it would otherwise have made" from
    // "nothing happening". Only the first is worth a word on screen.
    const suppressed = lockActive && pc.projections.some(
      p => Number.isFinite(p.projectedPercent) && Math.abs(p.projectedPercent) >= PRICE_CHANGE_THRESHOLD,
    );
    return noSignal({
      ...base,
      displayable: suppressed,
      near: nearApproach(pc.projections, windows, reachable),
    });
  }

  const tier = likelihoodTier(hit.likelihood);
  const timing = TIMING[hit.offset] || null;

  return {
    ...noSignal(),
    ...base,
    direction: hit.projectedPercent > 0 ? 'rise' : 'fall',
    offset: hit.offset,
    timing: timing ? timing.key : null,
    timingLabel: timing ? timing.label : null,
    projectedPercent: hit.projectedPercent,
    likelihood: hit.likelihood,
    // A calibrating prediction is real but still settling, so it is shown
    // WITHOUT a confidence tier. Presenting "Strong signal" over a number the
    // API itself says is not settled is the one thing this must not do.
    tier: base.calibrating ? null : (tier ? tier.key : null),
    tierLabel: base.calibrating ? null : (tier ? tier.label : null),
    changeAt: hit.changeAt,
    displayable: true,
  };
}

/**
 * The asymmetry, in one place.
 *
 * Buying a player who is about to RISE costs real money if you wait, and
 * selling one who is about to FALL loses team value if you wait. Those two are
 * ACTIONABLE. The opposite pairs are true and worth showing, but waiting is
 * the thing they argue for, so they are never dressed as urgent.
 *
 * Returns -1..1: positive means "this direction of travel favours acting now".
 */
export function priceUrgency(model, dir) {
  // A near approach leaves `direction` at 'none', so it returns 0 here by
  // construction: FPL projects no change, and a price that is not projected to
  // move may not reorder a single plan.
  if (!model || !model.available || model.direction === 'none') return 0;
  // A locked player cannot move and a calibrating one is not settled enough to
  // move a decision on. Both still DISPLAY; neither may push a recommendation.
  if (model.locked || model.calibrating) return 0;

  const tierWeight = { strong: 1, moderate: 0.6, slight: 0.3 }[model.tier] || 0;
  if (!tierWeight) return 0;

  // Sooner is worth more, and the fall-off is the offset itself so there is no
  // second invented constant.
  const timeWeight = 1 / (1 + model.offset);

  const acting = (dir === 'in' && model.direction === 'rise')
    || (dir === 'out' && model.direction === 'fall');
  const waiting = (dir === 'in' && model.direction === 'fall')
    || (dir === 'out' && model.direction === 'rise');

  // Acting counts full; waiting counts half and against, because "you might
  // save 0.1m by holding off" is a weaker argument than "this costs you 0.1m
  // tonight".
  const side = acting ? 1 : (waiting ? -0.5 : 0);
  return side * tierWeight * timeWeight;
}

/**
 * How urgency reads on a transfer card. One sentence per state, so the badge,
 * its tooltip and the drawer cannot drift apart.
 *
 * `near` opts a surface into the near-a-change state. It only ever fills the
 * silence: a player with a projected move or a lock reads exactly as he would
 * without it. A near badge is never urgent, because no change is projected and
 * waiting therefore costs nothing on FPL's own numbers.
 */
export function priceBadge(model, dir, { near = false } = {}) {
  if (!model || !model.available) return null;
  if (!model.displayable) {
    if (!near || !model.near) return null;
    const n = model.near;
    const arrow = n.direction === 'rise' ? '↑' : '↓';
    return {
      kind: 'near',
      text: `${arrow} Near ${n.direction} ${n.timingLabel || 'soon'}${model.calibrating ? '?' : ''}`,
      urgent: false,
      model,
    };
  }

  if (model.direction === 'none') {
    // Only reachable when a live lock suppressed a crossing.
    return { kind: 'locked', text: 'Price locked', urgent: false, model };
  }

  const arrow = model.direction === 'rise' ? '↑' : '↓';
  const word = model.direction === 'rise' ? 'Rise' : 'Fall';
  const when = model.timingLabel || 'soon';

  if (model.calibrating) {
    return { kind: 'calibrating', text: `${arrow} ${word} ${when}?`, urgent: false, model };
  }

  return {
    kind: model.direction,
    text: `${arrow} ${word} ${when}`,
    urgent: priceUrgency(model, dir) > 0,
    model,
  };
}
