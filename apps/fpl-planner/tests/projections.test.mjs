import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildProjections,
  projectPlayerGw,
  underlyingRates,
  shrinkRates,
  positionRatePriors,
  priorNinetiesFor,
  defConComposite,
  bonusModel,
  PROJECTION_PARAMS,
} from '../js/engine/projections.js';

// --- a small world ---------------------------------------------------------

const SCORING = {
  long_play: 2,
  short_play: 1,
  goals_scored: { GKP: 10, DEF: 6, MID: 5, FWD: 4, 1: 10, 2: 6, 3: 5, 4: 4 },
  assists: 3,
  clean_sheets: { GKP: 4, DEF: 4, MID: 1, FWD: 0, 1: 4, 2: 4, 3: 1, 4: 0 },
  goals_conceded: { GKP: -1, DEF: -1, MID: 0, FWD: 0, 1: -1, 2: -1, 3: 0, 4: 0 },
  saves: 1,
  penalties_saved: 5,
  penalties_missed: -2,
  yellow_cards: -1,
  red_cards: -3,
  own_goals: -2,
  bonus: 1,
  defensive_contribution: { GKP: 0, DEF: 2, MID: 2, FWD: 2, 1: 0, 2: 2, 3: 2, 4: 2 },
};

const RULES = {
  season: 'test',
  totalEvents: 38,
  starters: 11,
  scoring: SCORING,
  defConThresholds: { 2: 10, 3: 12, 4: 12 },
};

function player(over = {}) {
  return {
    id: over.id || 1,
    webName: 'Test',
    teamId: 1,
    position: 3,
    nowCost: 70,
    status: 'a',
    chanceNext: null,
    minutes: 3000,
    starts: 34,
    totalPoints: 150,
    bonus: 10,
    bps: 600,
    saves: 0,
    goalsScored: 8,
    assists: 6,
    cleanSheets: 10,
    goalsConceded: 40,
    yellowCards: 4,
    redCards: 0,
    penaltiesSaved: 0,
    cbit: 120,
    recoveries: 200,
    tackles: 60,
    defCon: 380,
    xG: 8,
    xA: 6,
    xGI: 14,
    xGC: 45,
    per90: {},
    setPieces: { penaltiesOrder: null, directFreekicksOrder: null, cornersOrder: null },
    ...over,
  };
}

const FIXTURES = [
  { id: 1, event: 1, teamH: 1, teamA: 2, teamHDifficulty: 3, teamADifficulty: 3, kickoff: 'k1', finished: false },
  { id: 2, event: 1, teamH: 3, teamA: 4, teamHDifficulty: 3, teamADifficulty: 3, kickoff: 'k2', finished: false },
  // Gameweek 2 is a blank for club 1.
  { id: 3, event: 2, teamH: 2, teamA: 3, teamHDifficulty: 3, teamADifficulty: 3, kickoff: 'k3', finished: false },
  // Gameweek 3 is a double for club 1.
  { id: 4, event: 3, teamH: 1, teamA: 2, teamHDifficulty: 3, teamADifficulty: 3, kickoff: 'k4', finished: false },
  { id: 5, event: 3, teamH: 3, teamA: 1, teamHDifficulty: 3, teamADifficulty: 3, kickoff: 'k5', finished: false },
];

function makeGameState(extraPlayers = [], rules = RULES) {
  const players = new Map();
  let id = 100;
  // A filler league so the position priors and the bonus curve have a
  // population to be measured from.
  for (let t = 1; t <= 4; t++) {
    for (let pos = 1; pos <= 4; pos++) {
      for (const spec of [
        { minutes: 3200, starts: 36, bps: 700, bonus: 14, nowCost: 90 },
        { minutes: 2200, starts: 25, bps: 420, bonus: 6, nowCost: 65 },
        { minutes: 800, starts: 8, bps: 150, bonus: 1, nowCost: 50 },
        { minutes: 0, starts: 0, bps: 0, bonus: 0, nowCost: 40 },
      ]) {
        players.set(id, player({ id, teamId: t, position: pos, ...spec }));
        id++;
      }
    }
  }
  for (const p of extraPlayers) players.set(p.id, p);

  return {
    rules,
    teams: new Map([1, 2, 3, 4].map(i => [i, { id: i, shortName: `T${i}` }])),
    players,
    fixtures: FIXTURES,
    events: [],
    fetchedAt: '2026-08-10T00:00:00.000Z',
    nextEvent: 1,
    currentEvent: null,
    seasonStarted: false,
  };
}

function makeStrength({ mu = 1.4, homeAdvantage = 1.15, teams } = {}) {
  const entries = teams || [
    { id: 1, attack: 1.2, defence: 0.9 },
    { id: 2, attack: 1.0, defence: 1.0 },
    { id: 3, attack: 0.8, defence: 1.2 },
    { id: 4, attack: 1.0, defence: 1.0 },
  ];
  return {
    asOfGw: 1,
    source: 'prior',
    leagueMeanGoals: mu,
    homeAdvantage,
    matchesUsed: 0,
    teams: new Map(entries.map(e => [e.id, { teamId: e.id, ...e }])),
    params: {},
  };
}

const project = (p, gw = 1, opts = {}) => {
  const gameState = opts.gameState || makeGameState([p]);
  return projectPlayerGw(p, {
    gameState,
    strength: opts.strength || makeStrength(),
    gw,
    model: opts.model || null,
  });
};

// --- tests -----------------------------------------------------------------

test('defensive contribution uses the per-position stat definition', () => {
  const def = player({ position: 2, cbit: 120, recoveries: 200, tackles: 60 });
  const mid = player({ position: 3, cbit: 120, recoveries: 200, tackles: 60 });
  const fwd = player({ position: 4, cbit: 120, recoveries: 200, tackles: 60 });
  const gkp = player({ position: 1, cbit: 37, recoveries: 304, tackles: 1 });
  assert.equal(defConComposite(def), 180, 'defenders: CBIT + tackles');
  assert.equal(defConComposite(mid), 380, 'midfielders: CBIT + recoveries + tackles');
  assert.equal(defConComposite(fwd), 380, 'forwards: CBIT + recoveries + tackles');
  assert.equal(defConComposite(gkp), 0, 'goalkeepers cannot earn it');
});

test('underlying rates read expected goals, never goals scored or points', () => {
  const lucky = player({ xG: 5, xA: 5, goalsScored: 20, assists: 20, totalPoints: 260 });
  const unlucky = player({ xG: 5, xA: 5, goalsScored: 0, assists: 0, totalPoints: 40 });
  const a = underlyingRates(lucky);
  const b = underlyingRates(unlucky);
  assert.deepEqual(a, b);
  assert.ok(Math.abs(a.xG - 5 / (3000 / 90)) < 1e-12);
});

test('the position rate prior is minutes weighted, so a cameo cannot move it', () => {
  // A mean of per-player rates is dominated by the players whose rates are
  // extrapolations of a cameo, which is the exact noise the shrinkage exists to
  // remove. A minutes-weighted ratio cannot be moved that way: the cameo
  // contributes its own two minutes to both sides.
  const cameo = player({ id: 7, position: 4, minutes: 2, xG: 0, xA: 0.37, bps: 7 });
  const withCameo = positionRatePriors(makeGameState([cameo])).rateFor(4).xA;
  const withoutCameo = positionRatePriors(makeGameState([])).rateFor(4).xA;

  // The same cameo, entering a mean OF PER-PLAYER RATES rather than a
  // minutes-weighted ratio. His own rate is 16.65 per 90.
  const forwards = [...makeGameState([cameo]).players.values()].filter(p => p.position === 4 && p.minutes > 0);
  const perPlayer = forwards.reduce((s, p) => s + p.xA / (p.minutes / 90), 0) / forwards.length;

  assert.ok(Math.abs(withCameo - withoutCameo) < withoutCameo * 0.01, `moved to ${withCameo} from ${withoutCameo}`);
  assert.ok(perPlayer > withCameo * 3, `a per-player mean is dominated by the cameo: ${perPlayer}`);
});

test('shrinkRates is the documented posterior, exactly', () => {
  const p = player({ id: 7, position: 4, minutes: 450, xG: 3, xA: 1, bps: 90 });
  const priors = positionRatePriors(makeGameState([p]));
  const raw = underlyingRates(p);
  const shrunk = shrinkRates(raw, { position: 4, priors });

  assert.equal(shrunk.nineties, raw.nineties);
  for (const key of ['xG', 'xA', 'bps', 'saves', 'defCon', 'yellow', 'red', 'pensSaved']) {
    const k = priorNinetiesFor(key, 4);
    const expected = (raw[key] * raw.nineties + priors.rateFor(4)[key] * k) / (raw.nineties + k);
    assert.ok(Math.abs(shrunk[key] - expected) < 1e-12, `${key}: ${shrunk[key]} vs ${expected}`);
  }
});

test('a cameo rate is pulled to the position prior and a full season is not', () => {
  // The 2-minute player whose 0.37 expected assists read as 16.65 per 90 and
  // projected 19.9 points. There is no threshold in the mechanism: the weight is
  // continuous in how much football is behind the rate.
  const cameo = player({ id: 7, position: 4, minutes: 2, xG: 0, xA: 0.37, bps: 7 });
  const veteran = player({ id: 8, position: 4, minutes: 3000, xG: 18, xA: 6, bps: 700 });
  const gameState = makeGameState([cameo, veteran]);
  const priors = positionRatePriors(gameState);

  const rawCameo = underlyingRates(cameo);
  assert.ok(rawCameo.xA > 16, `the raw extrapolation is the defect: ${rawCameo.xA}`);
  const shrunkCameo = shrinkRates(rawCameo, { position: 4, priors });
  assert.ok(shrunkCameo.xA < 0.5, `two minutes cannot outvote the league: ${shrunkCameo.xA}`);

  const rawVeteran = underlyingRates(veteran);
  const shrunkVeteran = shrinkRates(rawVeteran, { position: 4, priors });
  assert.ok(
    Math.abs(shrunkVeteran.xG - rawVeteran.xG) < rawVeteran.xG * 0.25,
    'a full season of evidence is mostly its own',
  );

  const r = projectPlayerGw(cameo, { gameState, strength: makeStrength(), gw: 1 });
  assert.ok(r.xPoints < 6, `a two-minute cameo must not project a haul: ${r.xPoints}`);
});

test('a player with no minutes at all IS the position prior', () => {
  // Zero nineties is not a special case in the code, and it must not be: the
  // posterior at n = 0 is the prior, which is the only defensible thing to say
  // about a player nothing is known about.
  const rookie = player({
    id: 7, position: 3, minutes: 0, starts: 0, xG: 0, xA: 0, bps: 0, bonus: 0,
    saves: 0, yellowCards: 0, redCards: 0, penaltiesSaved: 0, cbit: 0, recoveries: 0, tackles: 0,
  });
  const priors = positionRatePriors(makeGameState([rookie]));
  const shrunk = shrinkRates(underlyingRates(rookie), { position: 3, priors });
  for (const key of ['xG', 'xA', 'bps']) {
    assert.ok(Math.abs(shrunk[key] - priors.rateFor(3)[key]) < 1e-12, `${key}: ${shrunk[key]}`);
  }
  assert.ok(shrunk.bps > 0, 'and that prior is a real number, not zero');
});

test('cards and penalty saves have no between-player signal, so they are the prior', () => {
  // Measured tau^2 came out at or below zero for every red-card row, for penalty
  // saves and for a forward's yellows, so those rates get PRIOR_NINETIES_MAX and
  // no player is distinguishable from his position. A booking spree over half a
  // season must not become a projection.
  assert.equal(priorNinetiesFor('red', 3), PROJECTION_PARAMS.priorNinetiesMax);
  assert.equal(priorNinetiesFor('pensSaved', 1), PROJECTION_PARAMS.priorNinetiesMax);
  assert.equal(priorNinetiesFor('yellow', 4), PROJECTION_PARAMS.priorNinetiesMax);

  const booked = player({ id: 7, position: 4, minutes: 900, yellowCards: 9, redCards: 2 });
  const priors = positionRatePriors(makeGameState([booked]));
  const raw = underlyingRates(booked);
  const shrunk = shrinkRates(raw, { position: 4, priors });
  assert.ok(raw.yellow > 0.8, `the raw rate is extreme: ${raw.yellow}`);
  assert.ok(
    Math.abs(shrunk.yellow - priors.rateFor(4).yellow) < Math.abs(raw.yellow - priors.rateFor(4).yellow) * 0.1,
    `${shrunk.yellow} should be within a tenth of the way from the prior toward ${raw.yellow}`,
  );
});

test('the projected mean equals the sum of the analytic component means', () => {
  // A strong check of the whole discrete-distribution machinery: the mean of
  // the convolved distribution must agree with independently computed
  // component expectations. The residual is Poisson tail truncation only.
  for (const pos of [1, 2, 3, 4]) {
    const p = player({ id: 7, position: pos, saves: pos === 1 ? 90 : 0, penaltiesSaved: pos === 1 ? 2 : 0 });
    const r = project(p);
    const sum = Object.values(r.pointsBreakdown).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(r.xPoints - sum) < 2e-3, `position ${pos}: ${r.xPoints} vs ${sum}`);
  }
});

test('appearance points follow directly from the minutes model', () => {
  const r = project(player({ id: 7, position: 4 }));
  const expected = 2 * r.p60 + 1 * (r.pAppear - r.p60);
  assert.ok(Math.abs(r.pointsBreakdown.appearance - expected) < 1e-9);
});

test('every points coefficient comes from the rules object', () => {
  const p = player({ id: 7, position: 3 });
  const base = project(p);
  const doubled = JSON.parse(JSON.stringify(RULES));
  doubled.scoring.goals_scored[3] = 10;
  doubled.scoring.goals_scored.MID = 10;
  const gameState = makeGameState([p], doubled);
  const r = projectPlayerGw(p, { gameState, strength: makeStrength(), gw: 1 });
  assert.ok(Math.abs(r.pointsBreakdown.goals - 2 * base.pointsBreakdown.goals) < 1e-9);
  assert.ok(r.xPoints > base.xPoints);
});

test('the defensive contribution threshold comes from rules, not from this module', () => {
  const p = player({ id: 7, position: 3, cbit: 300, recoveries: 500, tackles: 200 });
  const base = project(p);
  assert.ok(base.pointsBreakdown.defcon > 0.2, `expected real defcon value, got ${base.pointsBreakdown.defcon}`);

  const harder = JSON.parse(JSON.stringify(RULES));
  harder.defConThresholds[3] = 40;
  const r = projectPlayerGw(p, { gameState: makeGameState([p], harder), strength: makeStrength(), gw: 1 });
  assert.ok(r.pointsBreakdown.defcon < base.pointsBreakdown.defcon / 10);
});

test('goalkeepers project saves, clean sheets and penalty saves, and no defensive contribution', () => {
  const keeper = player({ id: 7, position: 1, saves: 130, penaltiesSaved: 3, xG: 0, xA: 0.1, cbit: 40, recoveries: 300, tackles: 2 });
  const r = project(keeper);
  assert.ok(r.pointsBreakdown.saves > 0);
  assert.ok(r.pointsBreakdown.cleanSheets > 0);
  assert.ok(r.pointsBreakdown.penaltySaves > 0);
  assert.equal(r.pointsBreakdown.defcon, 0);
  assert.ok(r.pointsBreakdown.conceded < 0, 'a keeper loses points for goals conceded');
});

test('keeper saves scale with the opponent threat and clean sheets move the other way', () => {
  const keeper = player({ id: 7, position: 1, saves: 130, xG: 0, xA: 0 });
  const easy = makeStrength({
    teams: [{ id: 1, attack: 1, defence: 1 }, { id: 2, attack: 0.4, defence: 1 }, { id: 3, attack: 1, defence: 1 }, { id: 4, attack: 1, defence: 1 }],
  });
  const hard = makeStrength({
    teams: [{ id: 1, attack: 1, defence: 1 }, { id: 2, attack: 2.0, defence: 1 }, { id: 3, attack: 1, defence: 1 }, { id: 4, attack: 1, defence: 1 }],
  });
  const a = project(keeper, 1, { strength: easy });
  const b = project(keeper, 1, { strength: hard });
  assert.ok(b.components.xSaves > a.components.xSaves, 'more shots faced means more saves');
  assert.ok(b.pointsBreakdown.cleanSheets < a.pointsBreakdown.cleanSheets);
  assert.ok(b.pointsBreakdown.conceded < a.pointsBreakdown.conceded);
});

test('attacking output scales with the fixture, not just with the player', () => {
  const striker = player({ id: 7, position: 4, xG: 18, xA: 4 });
  const soft = makeStrength({
    teams: [{ id: 1, attack: 1.2, defence: 0.9 }, { id: 2, attack: 1, defence: 1.8 }, { id: 3, attack: 1, defence: 1 }, { id: 4, attack: 1, defence: 1 }],
  });
  const tough = makeStrength({
    teams: [{ id: 1, attack: 1.2, defence: 0.9 }, { id: 2, attack: 1, defence: 0.5 }, { id: 3, attack: 1, defence: 1 }, { id: 4, attack: 1, defence: 1 }],
  });
  const a = project(striker, 1, { strength: soft });
  const b = project(striker, 1, { strength: tough });
  assert.ok(a.components.xGoals > b.components.xGoals * 2, 'a soft fixture should be worth much more');
  assert.ok(a.xPoints > b.xPoints);
});

test('set-piece and penalty duty measurably raise the projection', () => {
  const base = player({ id: 7, position: 3, xG: 6, xA: 6 });
  const first = player({ ...base, setPieces: { penaltiesOrder: 1, directFreekicksOrder: 1, cornersOrder: 1 } });
  const second = player({ ...base, setPieces: { penaltiesOrder: 2, directFreekicksOrder: 2, cornersOrder: 2 } });

  const b = project(base);
  const f = project(first);
  const s = project(second);
  assert.ok(f.xPoints > b.xPoints, `first choice ${f.xPoints} should beat no duty ${b.xPoints}`);
  assert.ok(f.xPoints > s.xPoints, 'first choice should beat second choice');
  assert.ok(s.xPoints > b.xPoints, 'second choice should still beat no duty');
  assert.ok(f.components.xGoals > b.components.xGoals * (1 + PROJECTION_PARAMS.penaltyOrderBoost[0] / 2));
});

test('recent points luck does not move a projection', () => {
  // Identical underlying numbers, wildly different realized returns.
  const lucky = player({ id: 7, xG: 6, xA: 6, goalsScored: 18, assists: 14, totalPoints: 240, bonus: 25 });
  const unlucky = player({ id: 8, xG: 6, xA: 6, goalsScored: 1, assists: 1, totalPoints: 55, bonus: 1 });
  const gameState = makeGameState([lucky, unlucky]);
  const strength = makeStrength();
  const a = projectPlayerGw(lucky, { gameState, strength, gw: 1 });
  const b = projectPlayerGw(unlucky, { gameState, strength, gw: 1 });
  // Documented tolerance: 0.05 points. The measured difference is zero, because
  // no code path reads goals, assists, bonus collected or total points.
  assert.ok(Math.abs(a.xPoints - b.xPoints) < 0.05, `${a.xPoints} vs ${b.xPoints}`);
  assert.ok(Math.abs(a.xPoints - b.xPoints) < 1e-12, 'and in fact identical');
});

test('recency weighting works on underlying stats when per-gameweek history exists', () => {
  const rows = (values) => values.map((xg, i) => ({
    gw: i + 1, minutes: 90, xG: xg, xA: 0.1, bps: 25, saves: 0,
    cbit: 3, recoveries: 5, tackles: 2, yellowCards: 0, redCards: 0, penaltiesSaved: 0,
  }));
  const rising = player({ id: 7, position: 4, history: rows([0.1, 0.1, 0.1, 0.1, 0.9, 0.9, 0.9, 0.9]) });
  const fading = player({ id: 8, position: 4, history: rows([0.9, 0.9, 0.9, 0.9, 0.1, 0.1, 0.1, 0.1]) });

  const a = underlyingRates(rising, { gw: 9 });
  const b = underlyingRates(fading, { gw: 9 });
  assert.equal(a.source, 'history');
  // Same eight gameweeks, same season total, opposite order. A model without
  // recency weighting would return identical rates for these two.
  assert.ok(a.xG > b.xG * 1.35, `${a.xG} vs ${b.xG}`);
  assert.ok(Math.abs((a.xG + b.xG) - 1.0) < 1e-9, 'the unweighted totals are equal by construction');

  const base = makeGameState([rising, fading]);
  const gameState = {
    ...base,
    fixtures: [...FIXTURES, { id: 9, event: 9, teamH: 1, teamA: 2, teamHDifficulty: 3, teamADifficulty: 3, kickoff: 'k9', finished: false }],
  };
  const strength = makeStrength();
  const ra = projectPlayerGw(rising, { gameState, strength, gw: 9 });
  const rb = projectPlayerGw(fading, { gameState, strength, gw: 9 });
  assert.ok(ra.xPoints > rb.xPoints, `${ra.xPoints} vs ${rb.xPoints}`);
});

test('history from the gameweek being projected is never read', () => {
  const rows = [
    { gw: 1, minutes: 90, xG: 0.1, xA: 0, bps: 20, cbit: 1, recoveries: 1, tackles: 1 },
    { gw: 2, minutes: 90, xG: 0.1, xA: 0, bps: 20, cbit: 1, recoveries: 1, tackles: 1 },
    { gw: 3, minutes: 90, xG: 5.0, xA: 0, bps: 20, cbit: 1, recoveries: 1, tackles: 1 },
  ];
  const p = player({ id: 7, position: 4, history: rows });
  const before = underlyingRates(p, { gw: 3 });
  const after = underlyingRates(p, { gw: 4 });
  assert.ok(Math.abs(before.xG - 0.1) < 1e-9, `gameweek 3 must be invisible when projecting it: ${before.xG}`);
  assert.ok(after.xG > 1, 'and visible once it is in the past');
});

test('a blank gameweek projects exactly zero and a double sums over fixtures', () => {
  const p = player({ id: 7, position: 3 });
  const single = project(p, 1);
  const blank = project(p, 2);
  const double = project(p, 3);

  assert.equal(blank.fixtures.length, 0);
  assert.equal(blank.xPoints, 0);
  assert.equal(blank.xMins, 0);
  assert.equal(blank.sd, 0);
  assert.equal(blank.pAppear, 0);

  assert.equal(single.fixtures.length, 1);
  assert.equal(double.fixtures.length, 2);
  assert.ok(double.xPoints > single.xPoints * 1.5, `${double.xPoints} vs ${single.xPoints}`);
  assert.ok(double.xPoints < single.xPoints * 2, 'rotation risk means a double is worth less than twice a single');
  assert.ok(double.xMins > single.xMins * 1.5);
});

test('fixture metadata is carried through for the UI', () => {
  const r = project(player({ id: 7 }), 1);
  assert.deepEqual(r.fixtures, [
    { fixtureId: 1, opponentId: 2, isHome: true, fdr: 3, kickoff: 'k1' },
  ]);
  const away = project(player({ id: 7, teamId: 3 }), 3);
  assert.equal(away.fixtures.length, 1);
  assert.equal(away.fixtures[0].opponentId, 1);
  assert.equal(away.fixtures[0].isHome, true);
});

test('an unavailable player projects zero regardless of how good they are', () => {
  const p = player({ id: 7, position: 4, xG: 25, xA: 10, status: 'i' });
  const r = project(p);
  assert.equal(r.xPoints, 0);
  assert.equal(r.pAppear, 0);
  assert.equal(r.ceiling, 0);
});

test('sd and ceiling come from the composed distribution', () => {
  const steady = player({ id: 7, position: 2, xG: 1, xA: 1, cbit: 300, recoveries: 300, tackles: 150 });
  const explosive = player({ id: 8, position: 4, xG: 20, xA: 6, cbit: 5, recoveries: 20, tackles: 5 });
  const gameState = makeGameState([steady, explosive]);
  const strength = makeStrength();
  const a = projectPlayerGw(steady, { gameState, strength, gw: 1 });
  const b = projectPlayerGw(explosive, { gameState, strength, gw: 1 });

  assert.ok(a.sd > 0 && b.sd > 0);
  assert.ok(b.sd > a.sd, 'a striker carries more variance than a defensive defender');
  assert.ok(Number.isInteger(a.ceiling), 'the ceiling is a real point total, not a scaled mean');
  assert.ok(a.ceiling >= a.xPoints);
  assert.ok(b.ceiling - b.xPoints > a.ceiling - a.xPoints, 'the upside gap should be wider for the striker');
  // Not a fixed multiple of the mean, which is what "derived from the
  // distribution" has to mean in practice.
  assert.ok(Math.abs(b.ceiling / b.xPoints - a.ceiling / a.xPoints) > 0.05);
});

test('a start calibrator from a trained model moves the projection through pStart', () => {
  const p = player({ id: 7, position: 3 });
  const base = project(p);
  const halved = project(p, 1, {
    model: { modelVersion: 'test-1', startCalibrator: { predict: (v) => v * 0.5 } },
  });
  assert.ok(halved.pStart < base.pStart * 0.55);
  assert.ok(halved.xPoints < base.xPoints);
  assert.ok(halved.xMins < base.xMins);
});

test('buildProjections returns the ProjectionSet contract shape', () => {
  const a = player({ id: 7 });
  const b = player({ id: 8, teamId: 3 });
  const gameState = makeGameState([a, b]);
  const set = buildProjections({ gameState, strength: makeStrength(), gwFrom: 1, gwTo: 3 });

  assert.equal(set.gwFrom, 1);
  assert.equal(set.gwTo, 3);
  assert.ok(set.byPlayer instanceof Map);
  assert.equal(set.byPlayer.get(7).length, 3);
  assert.equal(set.modelVersion, 'analytic-1');
  assert.equal(set.dataFetchedAt, '2026-08-10T00:00:00.000Z');
  assert.ok(!Number.isNaN(Date.parse(set.generatedAt)));

  const row = set.get(7, 2);
  assert.equal(row.playerId, 7);
  assert.equal(row.gw, 2);
  assert.equal(set.get(7, 1), set.byPlayer.get(7)[0], 'index 0 is gwFrom');
  assert.equal(set.get(7, 4), null, 'out of range returns null');
  assert.equal(set.get(9999, 1), null, 'unknown player returns null');

  for (const key of ['xGoals', 'xAssists', 'xCleanSheet', 'xSaves', 'xBonus', 'xCards', 'xDefCon', 'xConceded', 'xPensSaved']) {
    assert.ok(key in row.components, `components.${key} missing`);
  }
  for (const key of ['pAppear', 'pStart', 'xMins', 'xPoints', 'sd', 'ceiling', 'confidence', 'fixtures']) {
    assert.ok(key in row, `${key} missing`);
  }
  assert.ok(['high', 'medium', 'low'].includes(row.confidence));
});

test('buildProjections can be limited to a subset of players', () => {
  const a = player({ id: 7 });
  const gameState = makeGameState([a]);
  const set = buildProjections({ gameState, strength: makeStrength(), gwFrom: 1, playerIds: [7] });
  assert.equal(set.byPlayer.size, 1);
  assert.equal(set.gwTo, 1);
});

test('the bonus curve is fitted from the league rather than assumed', () => {
  const gameState = makeGameState();
  const m = bonusModel(gameState);
  assert.equal(m.fitted, true, `expected a fitted curve, n = ${m.n}`);
  assert.ok(m.predict(700 / (3200 / 90)) > m.predict(150 / (800 / 90)), 'more BPS per 90 means more bonus');
  assert.ok(m.predict(0) >= 0);
  assert.equal(bonusModel(gameState), m, 'cached per game state');
});
