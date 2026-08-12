// The fixture model: two team ratings in, a full match outcome distribution out.
//
// Goals are modelled as independent Poisson counts with means taken from the
// strength model:
//
//   xGH = mu * attack(home) * defence(away) * homeAdvantage
//   xGA = mu * attack(away) * defence(home)
//
// Independence is an approximation (real scorelines are mildly correlated, the
// Dixon-Coles low-score correction exists for exactly that reason) but the
// quantities this app consumes are the marginals: expected team goals feeding
// player attacking rates, and P(opponent scores zero) feeding clean sheets.
// Both are unaffected by the dependence correction, so the extra parameter
// would buy nothing here.
//
// Truncation: the goal vectors run 0..MAX_GOALS with all remaining mass folded
// into the last cell, so the marginals sum to exactly 1 and therefore the
// win/draw/win probabilities do as well. That is asserted in the tests to 1e-9.

import { poissonVector } from './ml.js';
import { ratingFor } from './strength.js';

// Ten goals for one side in one match. The folded tail beyond it is worth about
// 1e-5 at the highest expectation this model produces.
const MAX_GOALS = 10;

export { MAX_GOALS };

export function expectedGoals(strength, homeTeamId, awayTeamId) {
  const home = ratingFor(strength, homeTeamId);
  const away = ratingFor(strength, awayTeamId);
  const mu = strength.leagueMeanGoals;
  return {
    xGH: mu * home.attack * away.defence * strength.homeAdvantage,
    xGA: mu * away.attack * home.defence,
  };
}

export function projectFixture(strength, homeTeamId, awayTeamId) {
  const { xGH, xGA } = expectedGoals(strength, homeTeamId, awayTeamId);
  const goalsDistH = poissonVector(xGH, MAX_GOALS);
  const goalsDistA = poissonVector(xGA, MAX_GOALS);

  let pWinHome = 0;
  let pDraw = 0;
  let pWinAway = 0;
  for (let h = 0; h <= MAX_GOALS; h++) {
    const ph = goalsDistH[h];
    if (ph === 0) continue;
    for (let a = 0; a <= MAX_GOALS; a++) {
      const joint = ph * goalsDistA[a];
      if (h > a) pWinHome += joint;
      else if (h === a) pDraw += joint;
      else pWinAway += joint;
    }
  }

  return {
    xGH,
    xGA,
    // A clean sheet for the home team is the away team failing to score, which
    // in a Poisson model is exactly exp(-xGA).
    pCSHome: goalsDistA[0],
    pCSAway: goalsDistH[0],
    pWinHome,
    pDraw,
    pWinAway,
    goalsDistH,
    goalsDistA,
  };
}

// Every fixture a club plays in a gameweek, straight from the fixture list.
// Zero entries is a blank gameweek and two or more is a double; neither is a
// special case anywhere in this app, they are just the length of this array.
export function fixturesForTeam(gameState, teamId, gw) {
  // A postponed fixture carries a null event. Asking for "gameweek null" (which
  // is what `gameState.nextEvent` is once the season is over) must not match
  // those, so the null case is answered before the comparison.
  if (gw === null || gw === undefined) return [];
  return gameState.fixtures.filter(
    f => f.event === gw && (f.teamH === teamId || f.teamA === teamId),
  );
}

// The per-fixture view a player projection needs: which side the player's club
// is on, who they face, and the model's expectations for both.
export function fixtureContext(gameState, strength, teamId, gw) {
  return fixturesForTeam(gameState, teamId, gw).map(f => {
    const isHome = f.teamH === teamId;
    const p = projectFixture(strength, f.teamH, f.teamA);
    return {
      fixtureId: f.id,
      opponentId: isHome ? f.teamA : f.teamH,
      isHome,
      fdr: isHome ? f.teamHDifficulty : f.teamADifficulty,
      kickoff: f.kickoff,
      teamXg: isHome ? p.xGH : p.xGA,
      opponentXg: isHome ? p.xGA : p.xGH,
      pCleanSheet: isHome ? p.pCSHome : p.pCSAway,
      opponentGoalsDist: isHome ? p.goalsDistA : p.goalsDistH,
      fixture: p,
    };
  });
}

// The club's own scoring level against an average opponent at a neutral venue.
// Player attacking rates are historical per-90 numbers accumulated at roughly
// this level, so dividing by it is what turns "his rate" into "his rate in THIS
// fixture" without double counting the club's overall quality.
export function baselineTeamGoals(strength, teamId) {
  const r = ratingFor(strength, teamId);
  return strength.leagueMeanGoals * r.attack;
}

export function baselineOpponentGoals(strength, teamId) {
  const r = ratingFor(strength, teamId);
  return strength.leagueMeanGoals * r.defence;
}
