// Captain and vice-captain (SPEC 11 and 12 acceptance criteria for captaincy).
//
// The armband is the one FPL decision that is explicitly a risk decision, so
// the assertions here are about the OBJECTIVE, not about "who has the most
// expected points": a case is constructed where the captain is deliberately not
// the highest-xP player, and the pair is checked as a pair.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chooseCaptain, CAPTAIN_PARAMS } from '../js/engine/captain.js';
import { makeRng } from '../js/engine/ml.js';

// --- a synthetic eleven -----------------------------------------------------

function makeWorld(specs) {
  const players = new Map();
  const rows = new Map();
  for (const s of specs) {
    players.set(s.id, {
      id: s.id,
      position: s.position ?? 3,
      teamId: s.teamId,
      nowCost: 60,
      status: 'a',
      setPieces: {
        penaltiesOrder: s.penaltiesOrder ?? null,
        directFreekicksOrder: s.freekicksOrder ?? null,
        cornersOrder: s.cornersOrder ?? null,
      },
    });
    rows.set(s.id, {
      playerId: s.id,
      gw: 1,
      fixtures: s.fixtures ?? [{ fixtureId: 1, opponentId: 99, isHome: true, fdr: 3 }],
      pAppear: s.pAppear ?? 0.95,
      pStart: s.pAppear ?? 0.95,
      xMins: 85,
      xPoints: s.xPoints,
      sd: s.sd ?? 3,
      ceiling: s.ceiling ?? s.xPoints * 1.8,
      confidence: s.confidence ?? 'high',
    });
  }
  const projections = {
    gwFrom: 1,
    gwTo: 1,
    byPlayer: new Map([...rows].map(([id, r]) => [id, [r]])),
    get(id, gw) { return gw === 1 ? rows.get(id) || null : null; },
  };
  const gameState = { players, teams: new Map(), fixtures: [], events: [] };
  return { projections, gameState, xi: specs.map(s => s.id) };
}

// Ten filler players who are never in contention, so each test reads as the
// contest it is about.
function filler(startId, count, { teamId = 50 } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    id: startId + i,
    teamId: teamId + i,
    xPoints: 2,
    ceiling: 4,
    pAppear: 0.9,
  }));
}

// --- the documented objective -----------------------------------------------

test('the captain is not simply the highest expected scorer', () => {
  // Player 1 has the higher mean. Player 2 has a materially higher ceiling on a
  // mean 0.2 lower, and captaincy is where a manager buys the upside.
  //
  //   balanced weights: 0.75 * mean + 0.25 * ceiling
  //   player 1: 0.75 * 8.0 + 0.25 * 12 = 9.00
  //   player 2: 0.75 * 7.8 + 0.25 * 16 = 9.85
  const world = makeWorld([
    { id: 1, teamId: 1, xPoints: 8.0, ceiling: 12, pAppear: 0.95 },
    { id: 2, teamId: 2, xPoints: 7.8, ceiling: 16, pAppear: 0.95 },
    ...filler(3, 9),
  ]);
  const result = chooseCaptain(world.xi, world.projections, 1, world.gameState);

  assert.equal(result.captain, 2, 'the higher ceiling should take the armband');
  assert.equal(result.xPoints, 7.8);
  assert.ok(result.captainScore > 0);
  // And the control: with an aggressive profile the upside weighs even more, so
  // the same answer holds, while a mean-only objective would pick player 1.
  const aggressive = chooseCaptain(world.xi, world.projections, 1, world.gameState, { risk: 'aggressive' });
  assert.equal(aggressive.captain, 2);
  const ranked = result.candidates;
  assert.equal(ranked[0].playerId, 2);
  assert.ok(ranked.find(c => c.playerId === 1).xPoints > ranked[0].xPoints);
});

test('a conservative profile can hand the armband back to the safer mean', () => {
  // Same two players, but now the ceiling gap is small enough that the weights
  // decide, which is what makes the risk profile a real parameter.
  const world = makeWorld([
    { id: 1, teamId: 1, xPoints: 8.0, ceiling: 12.0, pAppear: 0.95 },
    { id: 2, teamId: 2, xPoints: 7.8, ceiling: 13.0, pAppear: 0.95 },
    ...filler(3, 9),
  ]);
  assert.equal(chooseCaptain(world.xi, world.projections, 1, world.gameState, { risk: 'conservative' }).captain, 1);
  assert.equal(chooseCaptain(world.xi, world.projections, 1, world.gameState, { risk: 'aggressive' }).captain, 2);
});

test('the captain score and its components are reported for the explanation', () => {
  const world = makeWorld([
    { id: 1, teamId: 1, xPoints: 9, ceiling: 18, pAppear: 0.95 },
    ...filler(2, 10),
  ]);
  const result = chooseCaptain(world.xi, world.projections, 1, world.gameState);
  assert.equal(result.captain, 1);
  const c = result.components;
  assert.ok(Math.abs(c.meanTerm - 0.75 * 9) < 1e-12);
  assert.ok(Math.abs(c.upsideTerm - 0.25 * 18) < 1e-12);
  assert.ok(Math.abs(c.certaintyEquivalent - (c.meanTerm + c.upsideTerm)) < 1e-12);
  assert.equal(c.penaltyDuty, 0);
  assert.equal(c.confidencePenalty, 0);
  // captainScore is the pair's value: the captain plus the fallback.
  const own = c.certaintyEquivalent + c.penaltyDuty + c.setPieceDuty + c.fixture - c.confidencePenalty;
  assert.ok(Math.abs(result.captainScore - (own + c.fallbackValue)) < 1e-12);
  assert.equal(result.ceiling, 18);
  assert.equal(result.pAppear, 0.95);
  assert.equal(result.params.minCaptainPAppear, CAPTAIN_PARAMS.minCaptainPAppear);
});

// --- the minutes floor ------------------------------------------------------

test('a player below the minutes floor is never captained', () => {
  // Player 1 is the best bet on the pitch by a distance and a coin flip to be
  // on it. A captain who does not play costs the armband outright.
  const world = makeWorld([
    { id: 1, teamId: 1, xPoints: 12, ceiling: 24, pAppear: 0.4 },
    { id: 2, teamId: 2, xPoints: 6, ceiling: 11, pAppear: 0.95 },
    ...filler(3, 9),
  ]);
  const result = chooseCaptain(world.xi, world.projections, 1, world.gameState);
  assert.notEqual(result.captain, 1);
  assert.equal(result.captain, 2);
  assert.ok(result.pAppear >= CAPTAIN_PARAMS.minCaptainPAppear);
  assert.equal(result.floorRelaxed, false);
  // He is still allowed to be the vice, because the vice floor is lower and a
  // fallback only has to beat nothing.
  assert.ok(result.viceCaptain !== 1 || result.vice.pAppear >= CAPTAIN_PARAMS.minVicePAppear);
});

test('every candidate row carries a finite score and an explicit eligibility flag', () => {
  // The explanation layer renders these rows. An ineligible captaincy option is
  // expressed by the flag and by its place in the order, never by a score no
  // interface can print.
  const world = makeWorld([
    { id: 1, teamId: 1, xPoints: 12, ceiling: 24, pAppear: 0.4 },
    { id: 2, teamId: 2, xPoints: 6, ceiling: 11, pAppear: 0.95 },
    { id: 3, teamId: 3, xPoints: 5, ceiling: 9, pAppear: 0.2 },
    ...filler(4, 8),
  ]);
  const result = chooseCaptain(world.xi, world.projections, 1, world.gameState);

  for (const candidate of result.candidates) {
    assert.ok(Number.isFinite(candidate.captainScore), `player ${candidate.playerId} scored ${candidate.captainScore}`);
    assert.equal(typeof candidate.eligible, 'boolean');
    assert.equal(candidate.eligible, candidate.pAppear >= CAPTAIN_PARAMS.minCaptainPAppear);
  }

  // The chosen captain is still the top row, and the players who cannot be
  // captained are all below the players who can.
  assert.equal(result.candidates[0].playerId, result.captain);
  const firstIneligible = result.candidates.findIndex(c => !c.eligible);
  assert.ok(firstIneligible > 0);
  assert.ok(result.candidates.slice(firstIneligible).every(c => !c.eligible));
  // Player 1 is the best player on the pitch and still cannot take the armband,
  // so his score has to be visible rather than erased.
  const doubtful = result.candidates.find(c => c.playerId === 1);
  assert.equal(doubtful.eligible, false);
  assert.ok(doubtful.captainScore > result.candidates[0].captainScore);
});

test('when nobody clears the floor it relaxes to the most likely to play, and says so', () => {
  const world = makeWorld([
    { id: 1, teamId: 1, xPoints: 5, ceiling: 10, pAppear: 0.45 },
    { id: 2, teamId: 2, xPoints: 4, ceiling: 8, pAppear: 0.45 },
    ...filler(3, 9).map(f => ({ ...f, pAppear: 0.2 })),
  ]);
  const result = chooseCaptain(world.xi, world.projections, 1, world.gameState);
  assert.equal(result.floorRelaxed, true);
  assert.equal(result.captain, 1);
  assert.ok(result.pAppear < CAPTAIN_PARAMS.minCaptainPAppear);
});

// --- the vice ---------------------------------------------------------------

test('vice-captain value is weighted by the chance the captain does not play', () => {
  const build = (pAppear) => makeWorld([
    { id: 1, teamId: 1, xPoints: 9, ceiling: 18, pAppear },
    { id: 2, teamId: 2, xPoints: 7, ceiling: 14, pAppear: 0.98 },
    ...filler(3, 9),
  ]);

  const safe = chooseCaptain(build(0.98).xi, build(0.98).projections, 1, build(0.98).gameState);
  const doubtful = chooseCaptain(build(0.6).xi, build(0.6).projections, 1, build(0.6).gameState);

  assert.equal(safe.captain, 1);
  assert.equal(safe.viceCaptain, 2);
  assert.equal(doubtful.captain, 1);
  assert.equal(doubtful.viceCaptain, 2);

  // The fallback is worth 40 per cent of the vice when the captain is a 0.6,
  // and 2 per cent of him when the captain is a 0.98.
  assert.ok(doubtful.components.fallbackValue > safe.components.fallbackValue * 10);
  assert.ok(Math.abs(safe.components.fallbackValue / doubtful.components.fallbackValue - 0.02 / 0.4) < 1e-9);

  // Expected points from the armband: the captain's own, plus the vice's when
  // the captain does not play.
  assert.ok(Math.abs(doubtful.xPointsCaptaincy - (9 + 0.4 * 7)) < 1e-9);
  assert.ok(Math.abs(safe.xPointsCaptaincy - (9 + 0.02 * 7)) < 1e-9);
});

test('a vice at the captain club is penalised against an equivalent vice elsewhere', () => {
  // Two identical fallbacks. One shares the captain's fixture, so a
  // postponement, an abandonment or a rested spine takes both.
  const world = makeWorld([
    { id: 1, teamId: 7, xPoints: 9, ceiling: 18, pAppear: 0.8 },
    { id: 2, teamId: 7, xPoints: 7, ceiling: 14, pAppear: 0.95 },
    { id: 3, teamId: 8, xPoints: 7, ceiling: 14, pAppear: 0.95 },
    ...filler(4, 8),
  ]);
  const result = chooseCaptain(world.xi, world.projections, 1, world.gameState);
  assert.equal(result.captain, 1);
  assert.equal(result.viceCaptain, 3, 'the vice at another club survives what the captain does not');
  assert.equal(result.vice.sameClub, false);
  assert.equal(result.components.sameClubAsVice, false);
});

test('a stronger same-club vice still loses to a weaker one elsewhere', () => {
  const world = makeWorld([
    { id: 1, teamId: 7, xPoints: 9, ceiling: 18, pAppear: 0.8 },
    { id: 2, teamId: 7, xPoints: 7.4, ceiling: 15, pAppear: 0.95 },
    { id: 3, teamId: 8, xPoints: 7.0, ceiling: 14, pAppear: 0.95 },
    ...filler(4, 8),
  ]);
  const result = chooseCaptain(world.xi, world.projections, 1, world.gameState);
  assert.equal(result.viceCaptain, 3);
  // Half of the same-club vice's value is assumed to survive, which is the
  // documented correlation.
  assert.equal(CAPTAIN_PARAMS.sameClubCorrelation, 0.5);
});

test('when only a same-club vice exists the correlation penalty is reported', () => {
  const world = makeWorld([
    { id: 1, teamId: 7, xPoints: 9, ceiling: 18, pAppear: 0.7 },
    { id: 2, teamId: 7, xPoints: 7, ceiling: 14, pAppear: 0.95 },
    ...filler(3, 9).map(f => ({ ...f, xPoints: 0.5, ceiling: 1 })),
  ]);
  const result = chooseCaptain(world.xi, world.projections, 1, world.gameState);
  assert.equal(result.captain, 1);
  assert.equal(result.viceCaptain, 2);
  assert.equal(result.vice.sameClub, true);
  assert.equal(result.components.sameClubAsVice, true);
  assert.ok(result.components.viceCorrelationPenalty > 0);
});

test('the same-club discount can change the captain, not just the vice', () => {
  // Two captaincy candidates worth exactly the same. The best fallback on the
  // pitch (player 3, too doubtful to captain but fine as a vice) shares a club
  // with player 2, so player 2's armband is worth less AS A PAIR: if he misses,
  // his fallback is likelier to miss with him. That is the whole reason the
  // captain and the vice are chosen together.
  const world = makeWorld([
    { id: 1, teamId: 1, xPoints: 8, ceiling: 16, pAppear: 0.8 },
    { id: 2, teamId: 5, xPoints: 8, ceiling: 16, pAppear: 0.8 },
    { id: 3, teamId: 5, xPoints: 9.6, ceiling: 19.2, pAppear: 0.4 },
    ...filler(4, 8).map(f => ({ ...f, xPoints: 1, ceiling: 2 })),
  ]);
  const result = chooseCaptain(world.xi, world.projections, 1, world.gameState);
  assert.equal(result.captain, 1);
  assert.equal(result.viceCaptain, 3);
  assert.ok(Math.abs(result.components.fallbackValue - 0.2 * 12) < 1e-9);
});

// --- the small documented tilts ---------------------------------------------

test('penalty duty separates two otherwise identical players', () => {
  const world = makeWorld([
    { id: 1, teamId: 1, xPoints: 8, ceiling: 16, pAppear: 0.95 },
    { id: 2, teamId: 2, xPoints: 8, ceiling: 16, pAppear: 0.95, penaltiesOrder: 1 },
    ...filler(3, 9),
  ]);
  const result = chooseCaptain(world.xi, world.projections, 1, world.gameState);
  assert.equal(result.captain, 2);
  assert.equal(result.components.penaltyDuty, CAPTAIN_PARAMS.penaltyDutyBonus[0]);
});

test('an easier fixture and a better-evidenced projection both tilt the armband', () => {
  const easy = makeWorld([
    { id: 1, teamId: 1, xPoints: 8, ceiling: 16, pAppear: 0.95, fixtures: [{ fdr: 2 }] },
    { id: 2, teamId: 2, xPoints: 8, ceiling: 16, pAppear: 0.95, fixtures: [{ fdr: 5 }] },
    ...filler(3, 9),
  ]);
  assert.equal(chooseCaptain(easy.xi, easy.projections, 1, easy.gameState).captain, 1);

  const confident = makeWorld([
    { id: 1, teamId: 1, xPoints: 8, ceiling: 16, pAppear: 0.95, confidence: 'low' },
    { id: 2, teamId: 2, xPoints: 8, ceiling: 16, pAppear: 0.95, confidence: 'high' },
    ...filler(3, 9),
  ]);
  const result = chooseCaptain(confident.xi, confident.projections, 1, confident.gameState);
  assert.equal(result.captain, 2);
  assert.equal(result.components.confidencePenalty, CAPTAIN_PARAMS.confidencePenalty.high);
});

test('a blank gameweek player is not captained over a player with a fixture', () => {
  const world = makeWorld([
    { id: 1, teamId: 1, xPoints: 0, ceiling: 0, pAppear: 0, fixtures: [] },
    { id: 2, teamId: 2, xPoints: 4, ceiling: 8, pAppear: 0.9 },
    ...filler(3, 9).map(f => ({ ...f, xPoints: 1, ceiling: 2 })),
  ]);
  const result = chooseCaptain(world.xi, world.projections, 1, world.gameState);
  assert.equal(result.captain, 2);
  assert.notEqual(result.viceCaptain, 1);
});

// --- invariants -------------------------------------------------------------

test('captain and vice are always distinct and always in the eleven', () => {
  const rng = makeRng(31337);
  for (let trial = 0; trial < 300; trial++) {
    const specs = Array.from({ length: 11 }, (_, i) => {
      const pAppear = [0, 0.2, 0.35, 0.5, 0.7, 0.9, 1][Math.floor(rng() * 7)];
      const xPoints = Math.round(pAppear * (1 + rng() * 8) * 100) / 100;
      return {
        id: i + 1,
        // Only four clubs, so same-club pairs turn up constantly.
        teamId: 1 + Math.floor(rng() * 4),
        xPoints,
        ceiling: Math.round(xPoints * (1.2 + rng()) * 100) / 100,
        pAppear,
        sd: Math.round(rng() * 400) / 100,
        confidence: ['high', 'medium', 'low'][Math.floor(rng() * 3)],
        penaltiesOrder: rng() < 0.2 ? 1 : null,
        fixtures: pAppear === 0 ? [] : [{ fdr: 1 + Math.floor(rng() * 5) }],
      };
    });
    const world = makeWorld(specs);
    const risk = ['balanced', 'aggressive', 'conservative'][trial % 3];
    const result = chooseCaptain(world.xi, world.projections, 1, world.gameState, { risk });

    assert.ok(world.xi.includes(result.captain), 'captain must be in the eleven');
    assert.ok(world.xi.includes(result.viceCaptain), 'vice must be in the eleven');
    assert.notEqual(result.captain, result.viceCaptain);
    assert.ok(Number.isFinite(result.captainScore));
    if (!result.floorRelaxed) {
      assert.ok(result.pAppear >= CAPTAIN_PARAMS.minCaptainPAppear);
    } else {
      // Relaxing is only allowed when the whole eleven is below the floor.
      const best = Math.max(...specs.map(s => s.pAppear));
      assert.ok(best < CAPTAIN_PARAMS.minCaptainPAppear);
      assert.ok(Math.abs(result.pAppear - best) < 1e-12);
    }
    assert.equal(result.candidates.length, 11);
  }
});

test('the same inputs give the same armband every time', () => {
  const world = makeWorld([
    { id: 1, teamId: 1, xPoints: 6, ceiling: 12, pAppear: 0.9 },
    { id: 2, teamId: 2, xPoints: 6, ceiling: 12, pAppear: 0.9 },
    ...filler(3, 9),
  ]);
  const a = chooseCaptain(world.xi, world.projections, 1, world.gameState);
  const b = chooseCaptain(world.xi, world.projections, 1, world.gameState);
  assert.equal(a.captain, b.captain);
  assert.equal(a.viceCaptain, b.viceCaptain);
  // Ties break on the lower player id so two identical players never shuffle.
  assert.equal(a.captain, 1);
});
