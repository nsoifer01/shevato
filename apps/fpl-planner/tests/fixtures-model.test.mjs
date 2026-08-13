import test from 'node:test';
import assert from 'node:assert/strict';

import {
  projectFixture,
  expectedGoals,
  fixturesForTeam,
  fixtureContext,
  baselineTeamGoals,
  baselineOpponentGoals,
  MAX_GOALS,
} from '../js/engine/fixtures.js';

// A Strength object built by hand so every expectation below is arithmetic on
// numbers visible in this file, not on whatever the rating fitter happened to
// produce.
function strengthOf(entries, { mu = 1.4, homeAdvantage = 1.2 } = {}) {
  return {
    asOfGw: 1,
    source: 'prior',
    leagueMeanGoals: mu,
    homeAdvantage,
    matchesUsed: 0,
    teams: new Map(entries.map(e => [e.id, { teamId: e.id, attack: e.attack, defence: e.defence }])),
    params: {},
  };
}

const STRONG_V_WEAK = strengthOf([
  { id: 1, attack: 1.5, defence: 0.7 },
  { id: 2, attack: 0.8, defence: 1.3 },
  { id: 3, attack: 1.0, defence: 1.0 },
  { id: 4, attack: 1.1, defence: 0.9 },
]);

test('expected goals follow the documented multiplicative form', () => {
  const { xGH, xGA } = expectedGoals(STRONG_V_WEAK, 1, 2);
  assert.ok(Math.abs(xGH - 1.4 * 1.5 * 1.3 * 1.2) < 1e-12, `${xGH}`);
  assert.ok(Math.abs(xGA - 1.4 * 0.8 * 0.7) < 1e-12, `${xGA}`);
});

test('home advantage applies to the home side only', () => {
  const home = expectedGoals(STRONG_V_WEAK, 1, 3);
  const away = expectedGoals(STRONG_V_WEAK, 3, 1);
  assert.ok(home.xGH > away.xGA, 'the same club should score more at home');
  assert.ok(Math.abs(home.xGH / away.xGA - 1.2) < 1e-12);
  assert.ok(Math.abs(home.xGA - away.xGH / 1.2) < 1e-12);
});

test('outcome probabilities sum to one within 1e-9 across a wide grid', () => {
  for (const attack of [0.35, 0.8, 1.0, 1.6, 2.2]) {
    for (const defence of [0.35, 0.9, 1.4, 2.2]) {
      for (const mu of [0.9, 1.4, 2.0]) {
        const s = strengthOf(
          [{ id: 1, attack, defence }, { id: 2, attack: defence, defence: attack }],
          { mu },
        );
        const p = projectFixture(s, 1, 2);
        const total = p.pWinHome + p.pDraw + p.pWinAway;
        assert.ok(Math.abs(total - 1) < 1e-9, `sum ${total} for a=${attack} d=${defence} mu=${mu}`);
        const dh = p.goalsDistH.reduce((a, b) => a + b, 0);
        const da = p.goalsDistA.reduce((a, b) => a + b, 0);
        assert.ok(Math.abs(dh - 1) < 1e-12, `home goal distribution sums to ${dh}`);
        assert.ok(Math.abs(da - 1) < 1e-12, `away goal distribution sums to ${da}`);
        assert.equal(p.goalsDistH.length, MAX_GOALS + 1);
      }
    }
  }
});

test('clean sheet probability is Poisson P(opponent scores zero), hand computed', () => {
  const p = projectFixture(STRONG_V_WEAK, 1, 2);
  const xGH = 1.4 * 1.5 * 1.3 * 1.2;
  const xGA = 1.4 * 0.8 * 0.7;
  assert.ok(Math.abs(p.pCSHome - Math.exp(-xGA)) < 1e-12, `pCSHome ${p.pCSHome}`);
  assert.ok(Math.abs(p.pCSAway - Math.exp(-xGH)) < 1e-12, `pCSAway ${p.pCSAway}`);
  // Spot values: exp(-0.784) = 0.45657605, exp(-3.276) = 0.03777907
  assert.ok(Math.abs(p.pCSHome - 0.45657605) < 1e-8, `${p.pCSHome}`);
  assert.ok(Math.abs(p.pCSAway - 0.03777907) < 1e-8, `${p.pCSAway}`);
});

test('a stronger home side is favoured and the ordering is intuitive', () => {
  const p = projectFixture(STRONG_V_WEAK, 1, 2);
  assert.ok(p.pWinHome > p.pDraw);
  assert.ok(p.pDraw > p.pWinAway);
  assert.ok(p.pCSHome > p.pCSAway);
});

test('an evenly matched neutral fixture still favours the home side', () => {
  const even = strengthOf([{ id: 1, attack: 1, defence: 1 }, { id: 2, attack: 1, defence: 1 }]);
  const p = projectFixture(even, 1, 2);
  assert.ok(p.pWinHome > p.pWinAway);
  // exp(-1.4) against exp(-1.4 * 1.2): the away side has the harder job of
  // shutting out a home attack, so it is the LESS likely of the two to keep a
  // clean sheet even though the clubs are identical.
  assert.ok(Math.abs(p.pCSHome - 0.24659696) < 1e-8, `${p.pCSHome}`);
  assert.ok(Math.abs(p.pCSAway - 0.18637398) < 1e-8, `${p.pCSAway}`);
  assert.ok(p.pCSHome > p.pCSAway);
});

// --- fixturesForTeam: blank, single and double gameweeks --------------------

const FIXTURE_LIST = [
  { id: 10, event: 1, teamH: 1, teamA: 2, teamHDifficulty: 2, teamADifficulty: 4, kickoff: '2026-08-21T19:00:00Z' },
  { id: 11, event: 1, teamH: 3, teamA: 4, teamHDifficulty: 3, teamADifficulty: 3, kickoff: null },
  // Gameweek 2 has nothing for club 1: a blank.
  { id: 12, event: 2, teamH: 3, teamA: 2, teamHDifficulty: 3, teamADifficulty: 3, kickoff: null },
  // Gameweek 3 has club 1 twice: a double.
  { id: 13, event: 3, teamH: 1, teamA: 3, teamHDifficulty: 2, teamADifficulty: 4, kickoff: null },
  { id: 14, event: 3, teamH: 4, teamA: 1, teamHDifficulty: 4, teamADifficulty: 2, kickoff: null },
  // An unscheduled postponement carries a null event and belongs to no week.
  { id: 15, event: null, teamH: 1, teamA: 4, teamHDifficulty: 3, teamADifficulty: 3, kickoff: null },
];

const GAME_STATE = { fixtures: FIXTURE_LIST };

test('fixturesForTeam derives blanks and doubles from the fixture list', () => {
  assert.equal(fixturesForTeam(GAME_STATE, 1, 1).length, 1);
  assert.deepEqual(fixturesForTeam(GAME_STATE, 1, 2), [], 'gameweek 2 is a blank for club 1');
  assert.equal(fixturesForTeam(GAME_STATE, 1, 3).length, 2, 'gameweek 3 is a double for club 1');
  assert.deepEqual(fixturesForTeam(GAME_STATE, 1, 3).map(f => f.id), [13, 14]);
  // A fixture with no gameweek assigned is in no gameweek.
  assert.equal(fixturesForTeam(GAME_STATE, 1, null).length, 0);
});

test('fixtureContext reports side, opponent, difficulty and both expectations', () => {
  const ctx = fixtureContext(GAME_STATE, STRONG_V_WEAK, 1, 1);
  assert.equal(ctx.length, 1);
  assert.equal(ctx[0].fixtureId, 10);
  assert.equal(ctx[0].opponentId, 2);
  assert.equal(ctx[0].isHome, true);
  assert.equal(ctx[0].fdr, 2);
  assert.equal(ctx[0].kickoff, '2026-08-21T19:00:00Z');
  const p = projectFixture(STRONG_V_WEAK, 1, 2);
  assert.equal(ctx[0].teamXg, p.xGH);
  assert.equal(ctx[0].opponentXg, p.xGA);
  assert.equal(ctx[0].pCleanSheet, p.pCSHome);
});

test('fixtureContext flips the side for the away club', () => {
  const ctx = fixtureContext(GAME_STATE, STRONG_V_WEAK, 2, 1);
  assert.equal(ctx[0].isHome, false);
  assert.equal(ctx[0].opponentId, 1);
  assert.equal(ctx[0].fdr, 4);
  const p = projectFixture(STRONG_V_WEAK, 1, 2);
  assert.equal(ctx[0].teamXg, p.xGA);
  assert.equal(ctx[0].pCleanSheet, p.pCSAway);
});

test('fixtureContext returns one entry per fixture in a double gameweek', () => {
  const ctx = fixtureContext(GAME_STATE, STRONG_V_WEAK, 1, 3);
  assert.equal(ctx.length, 2);
  assert.equal(ctx[0].isHome, true);
  assert.equal(ctx[1].isHome, false);
  assert.ok(ctx[0].teamXg > ctx[1].teamXg, 'the home leg of the double should be the higher expectation');
});

test('baselines describe the club against an average opponent at a neutral venue', () => {
  assert.ok(Math.abs(baselineTeamGoals(STRONG_V_WEAK, 1) - 1.4 * 1.5) < 1e-12);
  assert.ok(Math.abs(baselineOpponentGoals(STRONG_V_WEAK, 1) - 1.4 * 0.7) < 1e-12);
});
