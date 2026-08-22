// THE GAMEWEEK LIFECYCLE, derived from the payload rather than assumed.
//
// WHY THIS FILE EXISTS
//
// Until the 2026-08-21 opening gameweek the app recognised two states,
// pre-season and not-pre-season, and read `fixture.finished` as the only match
// fact. That is wrong in both directions and it cost a live incident:
//
//   - `finished` stays false from the final whistle until FPL applies bonus and
//     stat corrections. The opening match of 2026/27 was still unsigned ELEVEN
//     HOURS after the whistle. For all of it the app believed no match had been
//     played, so `matchesPlayedByTeam`
//     returned zero for every club while those clubs' players carried this
//     season's minutes.
//   - Clubs do not move through the gameweek together. On the opening Friday
//     two clubs had played and eighteen had not, so any question of the form
//     "have the matches happened yet" has no single answer.
//
// So a phase is computed once, here, from the fixtures and events themselves,
// and every consumer reads it instead of re-deriving a different answer from
// `finished`. Two levels: each fixture has a phase, and the gameweek has one
// that summarises them.

/** A single fixture's position in its own lifecycle. */
export const FIXTURE_PHASE = Object.freeze({
  UPCOMING: 'upcoming',       // not kicked off
  LIVE: 'live',               // started, no full-time signal
  PROVISIONAL: 'provisional', // full time, bonus/stat corrections outstanding
  FINAL: 'final',             // FPL has signed it off
});

/** The gameweek's position in its lifecycle. */
export const GW_PHASE = Object.freeze({
  PRESEASON: 'preseason',             // the season has not started at all
  PRE_DEADLINE: 'pre-deadline',       // deadline still ahead, squads editable
  DEADLINE_PASSED: 'deadline-passed', // locked, nothing has kicked off
  IN_PROGRESS: 'in-progress',         // at least one fixture live
  PROVISIONAL: 'provisional',         // every started fixture at FT, none signed off
  FINALISING: 'finalising',           // fixtures final, event not data_checked
  COMPLETE: 'complete',               // event finished AND data_checked
});

/**
 * Where one fixture stands. `finished` is FPL's signed-off flag and
 * `finishedProvisional` its full-time flag; a fixture can carry the second
 * without the first for hours.
 */
export function fixturePhase(fixture) {
  if (!fixture) return FIXTURE_PHASE.UPCOMING;
  if (fixture.finished) return FIXTURE_PHASE.FINAL;
  if (fixture.finishedProvisional) return FIXTURE_PHASE.PROVISIONAL;
  if (fixture.started) return FIXTURE_PHASE.LIVE;
  return FIXTURE_PHASE.UPCOMING;
}

/** A fixture has been played out, whether or not FPL has signed it off. */
export function fixtureIsPlayed(fixture) {
  const phase = fixturePhase(fixture);
  return phase === FIXTURE_PHASE.FINAL || phase === FIXTURE_PHASE.PROVISIONAL;
}

/**
 * Matches each club has PLAYED OUT, counting provisional full-times.
 *
 * This is the denominator a start rate is measured against, and it is the one
 * number the incident turned on: counting only `finished` said zero while
 * twenty-two players carried ninety minutes each.
 */
export function matchesPlayedByClub(gameState) {
  const counts = new Map();
  for (const team of gameState.teams.keys()) counts.set(team, 0);
  for (const f of gameState.fixtures) {
    if (!fixtureIsPlayed(f)) continue;
    for (const t of [f.teamH, f.teamA]) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return counts;
}

/**
 * The gameweek lifecycle.
 *
 * `gw` is the gameweek being described (the current one, or the next one when
 * none is current). `planGw` is the gameweek a recommendation would be FOR,
 * which is the next one whose deadline has not passed.
 */
export function gameweekLifecycle(gameState, { now = Date.now() } = {}) {
  const events = gameState.events || [];
  const current = events.find(e => e.isCurrent) || null;
  const next = events.find(e => e.isNext) || null;
  const seasonStarted = events.some(e => e.isCurrent || e.isPrevious || e.finished);

  const event = current || next || events[0] || null;
  const gw = event ? event.id : null;
  const deadline = event && event.deadline ? Date.parse(event.deadline) : null;
  const deadlinePassed = deadline !== null && deadline <= now;

  const gwFixtures = gw === null ? [] : gameState.fixtures.filter(f => f.event === gw);
  const tally = { total: gwFixtures.length, upcoming: 0, live: 0, provisional: 0, final: 0 };
  for (const f of gwFixtures) tally[fixturePhase(f)]++;

  const played = matchesPlayedByClub(gameState);
  const clubsTotal = gameState.teams.size;
  let clubsPlayed = 0;
  for (const n of played.values()) if (n > 0) clubsPlayed++;

  // The gameweek a plan is FOR: the first event whose deadline is still ahead.
  const upcoming = events.find(e => e.deadline && Date.parse(e.deadline) > now) || null;
  const planGw = upcoming ? upcoming.id : (gw !== null ? gw : null);

  let phase;
  if (!seasonStarted && !deadlinePassed) phase = GW_PHASE.PRESEASON;
  else if (!deadlinePassed) phase = GW_PHASE.PRE_DEADLINE;
  else if (event && event.finished && event.dataChecked) phase = GW_PHASE.COMPLETE;
  else if (tally.total > 0 && tally.final === tally.total) phase = GW_PHASE.FINALISING;
  else if (tally.live > 0) phase = GW_PHASE.IN_PROGRESS;
  else if (tally.provisional > 0 && tally.upcoming === 0) phase = GW_PHASE.PROVISIONAL;
  else if (tally.provisional > 0 || tally.final > 0) phase = GW_PHASE.IN_PROGRESS;
  else phase = GW_PHASE.DEADLINE_PASSED;

  // A gameweek is settled when nothing about it can still move: every fixture
  // signed off AND the event marked data_checked. Anything less means the
  // numbers on screen are provisional, however finished the football looked.
  const settled = phase === GW_PHASE.COMPLETE;

  // Are this gameweek's matches all played out (whether or not signed off)?
  const allPlayedOut = tally.total > 0 && tally.upcoming === 0 && tally.live === 0;

  return {
    phase,
    gw,
    planGw,
    seasonStarted,
    deadline: event ? event.deadline : null,
    deadlinePassed,
    settled,
    allPlayedOut,
    fixtures: tally,
    clubsPlayed,
    clubsTotal,
    // Every club has played the same number of matches. Until this is true the
    // pool is not comparable across clubs, which is what made one club's
    // players look like non-starters beside eighteen clubs of untouched priors.
    clubsLevel: clubsPlayed === 0 || clubsPlayed === clubsTotal,
    matchesPlayedByClub: played,
  };
}

/** Short human label for a fixture phase, for the pitch and the drawer. */
export function fixturePhaseLabel(phase) {
  switch (phase) {
    case FIXTURE_PHASE.LIVE: return 'Live';
    case FIXTURE_PHASE.PROVISIONAL: return 'FT · bonus pending';
    case FIXTURE_PHASE.FINAL: return 'Final';
    default: return 'Upcoming';
  }
}

/** Short human label for the gameweek phase. */
export function gameweekPhaseLabel(phase) {
  switch (phase) {
    case GW_PHASE.PRESEASON: return 'Pre-season';
    case GW_PHASE.PRE_DEADLINE: return 'Before the deadline';
    case GW_PHASE.DEADLINE_PASSED: return 'Deadline passed';
    case GW_PHASE.IN_PROGRESS: return 'Matches in play';
    case GW_PHASE.PROVISIONAL: return 'Full time · being finalised';
    case GW_PHASE.FINALISING: return 'Being finalised';
    case GW_PHASE.COMPLETE: return 'Complete';
    default: return 'Unknown';
  }
}
