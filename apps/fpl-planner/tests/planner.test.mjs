// planner.js - the multi-gameweek rolling horizon, SPEC 12.
//
// The suite is built on a synthetic world with hand-written projections rather
// than on the projection model, because the behaviour under test is the
// DECISION RULE. Feeding the planner numbers it cannot argue with is the only
// way to say "this player is better now, this one is better over five weeks"
// and have the assertion mean what it says.
//
// The rules object is the real one, parsed from the committed bootstrap
// fixture, so squad size, club limit, budget, free-transfer cap and the
// eight-window chip catalogue are all the game's own.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRules } from '../js/engine/rules.js';
import { buildGameState } from '../js/engine/normalize.js';
import { buildSquadState } from '../js/engine/squad.js';
import { validatePlan } from '../js/engine/validate.js';
import { assembleSampleBundle } from '../js/data/sample.js';
import { buildPlan, PROGRESS_STAGES, RISK_PROFILES, PLANNER_PARAMS } from '../js/engine/planner.js';
import { UNLIMITED, isUnlimited } from '../js/engine/transfer-state.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => JSON.parse(readFileSync(join(here, ...p), 'utf8'));

const RULES = buildRules(read('fixtures', 'bootstrap.json'));

// ---------------------------------------------------------------------------
// A synthetic world
// ---------------------------------------------------------------------------

function makePlayer(id, position, teamId, nowCost, over = {}) {
  return {
    id,
    code: id,
    webName: `P${id}`,
    firstName: '',
    secondName: `P${id}`,
    teamId,
    position,
    nowCost,
    status: 'a',
    chanceNext: null,
    news: '',
    newsAdded: null,
    selectedByPercent: 5,
    minutes: 2000,
    starts: 25,
    totalPoints: 100,
    bonus: 5,
    bps: 300,
    saves: 0,
    goalsScored: 5,
    assists: 5,
    cleanSheets: 5,
    goalsConceded: 20,
    yellowCards: 2,
    redCards: 0,
    ownGoals: 0,
    penaltiesSaved: 0,
    penaltiesMissed: 0,
    cbit: 50,
    recoveries: 100,
    tackles: 30,
    defCon: 180,
    xG: 5,
    xA: 5,
    xGI: 10,
    xGC: 20,
    per90: { xG: 0.2, xA: 0.2, xGI: 0.4, xGC: 1, saves: 0, goalsConceded: 1, starts: 1, cleanSheets: 0.2, defCon: 8 },
    setPieces: { penaltiesOrder: null, directFreekicksOrder: null, cornersOrder: null },
    ...over,
  };
}

// Every club plays exactly once per gameweek, so nothing in these tests turns on
// a blank or a double. Those live in chips.test.mjs where they are the point.
function makeFixtures(teamIds, gwTo) {
  const out = [];
  let id = 1;
  for (let gw = 1; gw <= gwTo; gw++) {
    for (let i = 0; i + 1 < teamIds.length; i += 2) {
      out.push({
        id: id++,
        code: id,
        event: gw,
        kickoff: '2026-01-03T15:00:00Z',
        teamH: teamIds[i],
        teamA: teamIds[i + 1],
        teamHDifficulty: 3,
        teamADifficulty: 3,
        finished: false,
        started: false,
        teamHScore: null,
        teamAScore: null,
      });
    }
  }
  return out;
}

function makeGameState(players, gw) {
  const teamIds = [...new Set(players.map(p => p.teamId))].sort((a, b) => a - b);
  const teams = new Map(teamIds.map(id => [id, {
    id, code: id, name: `Club ${id}`, shortName: `C${id}`, strengthOverallHome: 3, strengthOverallAway: 3,
  }]));
  const events = [];
  for (let i = 1; i <= RULES.totalEvents; i++) {
    events.push({
      id: i,
      name: `Gameweek ${i}`,
      deadline: null,
      deadlineEpoch: null,
      finished: i < gw,
      dataChecked: i < gw,
      isCurrent: i === gw - 1,
      isNext: i === gw,
      isPrevious: i === gw - 2,
      averageEntryScore: null,
      highestScore: null,
    });
  }
  return {
    rules: RULES,
    teams,
    players: new Map(players.map(p => [p.id, p])),
    fixtures: makeFixtures(teamIds, RULES.totalEvents),
    events,
    fetchedAt: '2026-01-01T00:00:00.000Z',
    currentEvent: gw - 1,
    nextEvent: gw,
    seasonStarted: true,
  };
}

function makeProjections(gameState, gwFrom, gwTo, xp) {
  const byPlayer = new Map();
  for (const p of gameState.players.values()) {
    const rows = [];
    for (let gw = gwFrom; gw <= gwTo; gw++) {
      const fixtures = gameState.fixtures.filter(f => f.event === gw && (f.teamH === p.teamId || f.teamA === p.teamId));
      const points = fixtures.length ? xp(p.id, gw) : 0;
      rows.push({
        playerId: p.id,
        gw,
        fixtures: fixtures.map(f => ({
          fixtureId: f.id,
          opponentId: f.teamH === p.teamId ? f.teamA : f.teamH,
          isHome: f.teamH === p.teamId,
          fdr: 3,
          kickoff: f.kickoff,
        })),
        pAppear: fixtures.length ? 1 : 0,
        pStart: fixtures.length ? 1 : 0,
        xMins: fixtures.length ? 90 : 0,
        components: {
          xGoals: 0, xAssists: 0, xCleanSheet: 0, xSaves: 0, xBonus: 0,
          xCards: 0, xDefCon: 0, xConceded: 0, xPensSaved: 0,
        },
        xPoints: points,
        sd: 1,
        ceiling: Math.round(points + 3),
        confidence: 'high',
      });
    }
    byPlayer.set(p.id, rows);
  }
  return {
    gwFrom,
    gwTo,
    byPlayer,
    modelVersion: 'synthetic-1',
    generatedAt: '2026-01-01T00:00:00.000Z',
    dataFetchedAt: '2026-01-01T00:00:00.000Z',
    get(playerId, gw) {
      const rows = byPlayer.get(playerId);
      if (!rows) return null;
      const i = gw - gwFrom;
      return i >= 0 && i < rows.length ? rows[i] : null;
    },
  };
}

// Nothing in this file is about chips, and a chip in hand makes the planner run
// a 15-player rebuild on every call. A bare chip name consumes every window of
// that name, which is the documented way to say "all spent".
const NO_CHIPS = ['wildcard', 'freehit', 'bboost', '3xc'];

function makeSquadState(playerIds, { gw, prices, bankTenths = 5, freeTransfers = 1, chipsUsed = NO_CHIPS, source = 'picks' }) {
  return {
    entryId: 42,
    entryName: 'Test XI',
    managerName: 'Test Manager',
    gw,
    picks: playerIds.map((playerId, i) => ({
      playerId,
      slot: i + 1,
      isCaptain: false,
      isViceCaptain: false,
      multiplier: i < RULES.starters ? 1 : 0,
      purchaseTenths: prices.get(playerId),
      sellingTenths: prices.get(playerId),
    })),
    bankTenths,
    squadValueTenths: playerIds.reduce((s, id) => s + prices.get(id), 0) + bankTenths,
    freeTransfers,
    chipsUsed,
    chipsAvailable: [],
    overallRank: 250000,
    totalPoints: 500,
    source,
    asOf: '2026-01-01T00:00:00.000Z',
    warnings: [],
  };
}

// The reference squad: 15 players over 15 clubs, plus six unowned candidates
// over five more, so the club limit never binds and every decision in this file
// is about points.
const GW = 10;
const SQUAD_IDS = [101, 102, 201, 202, 203, 204, 205, 301, 302, 303, 304, 305, 401, 402, 403];

function baseRoster(extra = []) {
  return [
    makePlayer(101, 1, 1, 45), makePlayer(102, 1, 2, 40),
    makePlayer(201, 2, 3, 50), makePlayer(202, 2, 4, 50), makePlayer(203, 2, 5, 50),
    makePlayer(204, 2, 6, 50), makePlayer(205, 2, 7, 50),
    makePlayer(301, 3, 8, 60), makePlayer(302, 3, 9, 60), makePlayer(303, 3, 10, 60),
    makePlayer(304, 3, 11, 60), makePlayer(305, 3, 12, 55),
    makePlayer(401, 4, 13, 70), makePlayer(402, 4, 14, 70), makePlayer(403, 4, 15, 70),
    // Unowned and affordable: two midfielders the tests move around, plus one
    // cheap body per position so a 15-man rebuild is always constructible.
    makePlayer(310, 3, 16, 55), makePlayer(311, 3, 17, 55), makePlayer(312, 3, 18, 40),
    makePlayer(210, 2, 19, 40), makePlayer(410, 4, 20, 40), makePlayer(110, 1, 20, 40),
    ...extra,
  ];
}

// Held players are steady and unremarkable; 305 is the weak link every test
// sells. Candidates are given their numbers by each test.
function baseXp(id) {
  if (id === 305) return 1;
  if (id === 101) return 4;
  if (id === 102) return 3;
  if (id >= 201 && id <= 205) return 4.5 - (id - 201) * 0.1;
  if (id >= 301 && id <= 304) return 5 - (id - 301) * 0.1;
  if (id === 401) return 5.5;
  if (id === 402) return 5;
  if (id === 403) return 2;
  return 0.5;
}

function world({ xp, squadIds = SQUAD_IDS, gw = GW, horizon = 5, squad = {}, extra = [] } = {}) {
  const roster = baseRoster(extra);
  const gameState = makeGameState(roster, gw);
  const prices = new Map(roster.map(p => [p.id, p.nowCost]));
  const projections = makeProjections(gameState, gw, gw + Math.max(horizon, 5) + 4, xp);
  const squadState = makeSquadState(squadIds, { gw, prices, ...squad });
  return { gameState, projections, squadState, prices, roster };
}

const run = ({ gameState, projections, squadState }, options = {}, onProgress = null) => buildPlan({
  gameState,
  squadState,
  options: { projections, strength: {}, seed: 11, ...options },
  onProgress,
});

// ---------------------------------------------------------------------------
// THE HEADLINE TEST
// ---------------------------------------------------------------------------

test('the planner takes the player who is better over the horizon, not the one who is better this week', async () => {
  // The brief's scenario, made unambiguous. Both are midfielders, both cost the
  // same, both are affordable, and the only difference is WHEN their points
  // arrive. 310 is worth 9 this gameweek and nothing after it; 311 is worth 7
  // now and 8 in each of the next four.
  const xp = (id, gw) => {
    if (id === 310) return gw === GW ? 9 : 1;
    if (id === 311) return gw === GW ? 7 : 8;
    return baseXp(id);
  };
  const w = world({ xp });

  const horizonPlan = await run(w, { horizon: 5 });
  assert.deepEqual(horizonPlan.current.transfersOut, [305]);
  assert.deepEqual(horizonPlan.current.transfersIn, [311], 'the five gameweek plan must buy the player who is better across the horizon');

  // The same inputs with a one gameweek horizon: a single gameweek optimizer
  // takes 310, which is exactly the mistake SPEC 12 exists to prevent. If this
  // assertion ever fails, the test above has stopped proving anything.
  const gwPlan = await run(w, { horizon: 1 });
  assert.deepEqual(gwPlan.current.transfersIn, [310], 'a one gameweek horizon should take the player who is better right now');

  assert.ok(
    horizonPlan.current.xPointsGw < gwPlan.current.xPointsGw,
    `the horizon plan gives up points this week (${horizonPlan.current.xPointsGw} vs ${gwPlan.current.xPointsGw})`,
  );
});

test('a hit is only taken when the horizon gain clears the profile margin on top of its cost', async () => {
  // One free transfer, two rotten players, two excellent replacements. The
  // second transfer costs 4 points and is worth far more than that.
  const xp = (id, gw) => {
    if (id === 310 || id === 311) return 9;
    if (id === 305 || id === 403) return 0.2;
    return baseXp(id);
  };
  const w = world({ xp, squad: { freeTransfers: 1, bankTenths: 40 } });

  const aggressive = await run(w, { risk: 'aggressive' });
  assert.equal(aggressive.current.transferCount, 2);
  assert.equal(aggressive.current.hits, 1);
  assert.equal(aggressive.current.hitCostPoints, RULES.hitCost);

  // The same opportunity under a profile that never takes a hit.
  const conservative = await run(w, { risk: 'conservative' });
  assert.equal(conservative.current.hits, 0);
  assert.equal(conservative.current.transferCount, 1);
});

test('a marginal upgrade never buys a hit', async () => {
  // 310 is half a point better than the man he replaces, every week. Over five
  // discounted gameweeks that is about 2 points, well under the 4 point cost.
  const xp = (id, gw) => {
    if (id === 310) return 5.5;
    if (id === 311) return 5.4;
    return baseXp(id);
  };
  const w = world({ xp, squad: { freeTransfers: 0 } });
  const plan = await run(w);
  assert.equal(plan.current.hits, 0, 'no hit for a marginal upgrade');
  assert.equal(plan.current.transferCount, 0);
  assert.equal(plan.current.explanation.headline, 'Make no transfers');
});

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

test('onProgress emits the five contract stages once each, in order', async () => {
  const seen = [];
  const w = world({ xp: baseXp });
  await run(w, {}, stage => seen.push(stage));

  assert.deepEqual(seen.map(s => s.key), ['load-team', 'analyze-players', 'project-fixtures', 'optimize-transfers', 'build-plan']);
  assert.deepEqual(seen.map(s => s.label), [
    'Loading your FPL team',
    'Analyzing players',
    'Projecting fixtures',
    'Optimizing transfers',
    'Building your Gameweek plan',
  ]);
  assert.deepEqual(seen, PROGRESS_STAGES.map(s => ({ ...s })), 'the emitted stages are the exported contract');
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i].pct > seen[i - 1].pct, 'pct must advance');
  }
  assert.equal(seen[seen.length - 1].pct, 1);
});

test('a missing onProgress is not an error', async () => {
  const w = world({ xp: baseXp });
  const plan = await run(w, {}, null);
  assert.ok(plan.current);
});

// ---------------------------------------------------------------------------
// Validation is the gate, not a formality
// ---------------------------------------------------------------------------

test('every plan the planner returns passes validatePlan, including the projected ones', async () => {
  const xp = (id, gw) => (id === 310 ? 9 : id === 311 ? 8.5 : baseXp(id));
  const w = world({ xp });
  const bundle = await run(w, { horizon: 5 });

  assert.deepEqual(bundle.validation, { ok: true, violations: [] });
  const current = validatePlan(bundle.current, bundle.squadState, w.gameState, RULES);
  assert.deepEqual(current.violations, []);
  assert.equal(bundle.future.length, 4);
  for (const plan of bundle.future) {
    assert.equal(plan.squad.length, RULES.squadSize);
    assert.equal(plan.startingXI.length, RULES.starters);
    assert.equal(new Set([...plan.startingXI, plan.bench.gk, ...plan.bench.order]).size, RULES.squadSize);
    assert.ok(plan.startingXI.includes(plan.captain));
    assert.ok(plan.startingXI.includes(plan.viceCaptain));
    assert.notEqual(plan.captain, plan.viceCaptain);
  }
});

test('an invalid plan throws instead of being returned', async () => {
  // Six players from one club against a limit of three. No single or double
  // transfer can make that squad legal, so every candidate the planner scores
  // is illegal and there is nothing legitimate left to return.
  const roster = baseRoster();
  for (const id of [201, 202, 203, 301, 302, 401]) {
    roster.find(p => p.id === id).teamId = 3;
  }
  const gameState = makeGameState(roster, GW);
  const prices = new Map(roster.map(p => [p.id, p.nowCost]));
  const projections = makeProjections(gameState, GW, GW + 8, baseXp);
  const squadState = makeSquadState(SQUAD_IDS, { gw: GW, prices });

  await assert.rejects(
    () => buildPlan({ gameState, squadState, options: { projections, strength: {}, seed: 1 } }),
    (err) => {
      assert.match(err.message, /refusing to return an invalid plan/);
      assert.match(err.message, /club_limit/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Draft (pre-season) mode
// ---------------------------------------------------------------------------

test('draft mode returns a legal, affordable opening 15 and still validates', async () => {
  const roster = baseRoster();
  const gameState = makeGameState(roster, 1);
  const projections = makeProjections(gameState, 1, 9, baseXp);
  const prices = new Map(roster.map(p => [p.id, p.nowCost]));
  const squadState = {
    ...makeSquadState([], { gw: 1, prices, source: 'draft' }),
    picks: [],
  };

  const bundle = await buildPlan({ gameState, squadState, options: { projections, strength: {}, seed: 5 } });
  const plan = bundle.current;

  assert.equal(plan.squad.length, RULES.squadSize);
  assert.equal(plan.explanation.headline, 'Build this opening 15');
  assert.equal(plan.transferCount, 0);
  assert.deepEqual(plan.transfersIn, []);
  assert.deepEqual(plan.transfersOut, []);
  assert.equal(plan.bankBeforeTenths, RULES.budgetTenths);
  assert.equal(plan.moneyOutTenths, plan.squad.reduce((s, id) => s + gameState.players.get(id).nowCost, 0));
  assert.equal(plan.bankAfterTenths, RULES.budgetTenths - plan.moneyOutTenths);
  assert.ok(plan.bankAfterTenths >= 0, 'a draft must be affordable');

  const counts = new Map();
  for (const id of plan.squad) {
    const pos = gameState.players.get(id).position;
    counts.set(pos, (counts.get(pos) || 0) + 1);
  }
  for (const pos of Object.values(RULES.positions)) {
    assert.equal(counts.get(pos.id), pos.squadSelect, `${pos.short} count`);
  }
  assert.deepEqual(validatePlan(plan, bundle.squadState, gameState, RULES).violations, []);
  assert.deepEqual(bundle.validation, { ok: true, violations: [] });
});

test('a pre-season plan is unlimited now and hands the season exactly one free transfer', async () => {
  // The defect: the draft carried `rules.maxFreeTransfers`, so the pre-season
  // screen read "5" and every projected gameweek after it read "5" as well.
  // Unlimited does not roll over. GW1 is unlimited, GW2 is 1, GW3 is 2 if the
  // one is not spent.
  const roster = baseRoster();
  const gameState = makeGameState(roster, 1);
  const projections = makeProjections(gameState, 1, 12, baseXp);
  const prices = new Map(roster.map(p => [p.id, p.nowCost]));
  // The shape buildSquadState hands over before the first deadline; that it
  // produces UNLIMITED rather than the cap is squad.test.mjs's assertion, and
  // this one is that the planner carries it through the whole horizon.
  const squadState = {
    ...makeSquadState([], { gw: 1, prices, source: 'draft', freeTransfers: UNLIMITED }),
    picks: [],
  };

  const bundle = await buildPlan({
    gameState, squadState, options: { projections, strength: {}, seed: 5, horizon: 3, futureTransfers: false },
  });

  assert.equal(bundle.squadState.freeTransfers, UNLIMITED);
  assert.ok(isUnlimited(bundle.squadState.transferState));
  assert.notEqual(bundle.squadState.freeTransfers, RULES.maxFreeTransfers);

  assert.equal(bundle.current.gw, 1);
  assert.equal(bundle.current.freeTransfersNextGw, 1, 'GW2 starts with one, not five');
  assert.deepEqual(bundle.future.map(p => p.gw), [2, 3]);
  assert.deepEqual(bundle.future.map(p => p.freeTransfersAfter), [1, 2]);
  assert.deepEqual(bundle.future.map(p => p.freeTransfersNextGw), [2, 3]);

  // The sentence a manager actually reads, which said "5 free transfers".
  const banked = bundle.future[0].explanation.rollReason.reasons.find(r => r.code === 'roll_banked');
  assert.equal(banked.value, 2);
  assert.match(banked.text, /with 2 free transfers/);

  const preSeason = bundle.current.explanation.rollReason.reasons.find(r => r.code === 'roll_preseason');
  assert.ok(preSeason, 'and the pre-season week says it is unlimited rather than quoting a count');
  assert.match(preSeason.text, /unlimited until the Gameweek 1 deadline/);
});

test('the free transfer count evolves gameweek by gameweek across the projected plans', async () => {
  // Nothing is worth buying, so every gameweek rolls and the count must climb
  // by exactly one per gameweek from the count the squad state carries.
  const w = world({ xp: baseXp, squad: { freeTransfers: 1 }, horizon: 5 });
  const bundle = await run(w, { horizon: 5 });

  const walk = [bundle.current, ...bundle.future];
  assert.deepEqual(walk.map(p => p.gw), [GW, GW + 1, GW + 2, GW + 3, GW + 4]);
  assert.deepEqual(walk.map(p => p.transferCount), [0, 0, 0, 0, 0], 'this scenario has nothing worth buying');
  assert.deepEqual(walk.map(p => p.freeTransfersAfter), [1, 2, 3, 4, 5]);
  assert.deepEqual(walk.map(p => p.freeTransfersNextGw), [2, 3, 4, 5, 5], 'and the cap holds at the end');
});

test('a squad at the cap that rolls again stays at the cap rather than banking a sixth', async () => {
  const w = world({ xp: baseXp, squad: { freeTransfers: RULES.maxFreeTransfers }, horizon: 3 });
  const bundle = await run(w, { horizon: 3 });
  const walk = [bundle.current, ...bundle.future];
  assert.deepEqual(walk.map(p => p.freeTransfersAfter), [5, 5, 5]);
  assert.deepEqual(walk.map(p => p.freeTransfersNextGw), [5, 5, 5]);
});

test('a player signed this gameweek is worth his price to sell in the gameweek after it', async () => {
  // A new signing used to be carried into the projected squad state with a NULL
  // selling price, so from the next gameweek on he raised nothing when sold.
  // The projected plan could then not afford any move funded by him, which is
  // exactly the move a one gameweek signing has to be able to make.
  //
  // 310 is enormous in this gameweek and worthless afterwards; 311 is the
  // reverse. So the plan buys 310 now and the projection for next gameweek sells
  // him again, which it can only do if his money is there.
  const xp = (id, gw) => {
    if (id === 310) return gw === GW ? 20 : 1;
    if (id === 311) return gw === GW ? 1 : 5;
    return baseXp(id);
  };
  const w = world({ xp, squad: { freeTransfers: 1 }, horizon: 3 });
  const bundle = await run(w, { horizon: 3, maxHits: 0 });

  assert.deepEqual(bundle.current.transfersIn, [310], 'the scenario has to actually sign someone');
  const price = w.gameState.players.get(310).nowCost;

  const next = bundle.future[0];
  assert.equal(next.gw, GW + 1);
  assert.deepEqual(next.transfersOut, [310], 'the projected gameweek sells the player signed the week before');
  assert.deepEqual(next.transfersIn, [311]);
  assert.equal(next.moneyInTenths, price, 'and he raises what was paid for him, not zero');
  assert.ok(next.bankAfterTenths >= 0);
});

// ---------------------------------------------------------------------------
// Horizon and discounting
// ---------------------------------------------------------------------------

test('the horizon is configurable and reported, and never runs past the last gameweek', async () => {
  const w = world({ xp: baseXp, horizon: 8 });
  const three = await run(w, { horizon: 3 });
  assert.equal(three.current.horizon, 3);
  assert.equal(three.dataStatus.horizon, 3);
  assert.equal(three.future.length, 2, 'a horizon of 3 projects this gameweek plus two');

  const dflt = await run(w, {});
  assert.equal(dflt.current.horizon, PLANNER_PARAMS.defaultHorizon);
  assert.equal(dflt.future.length, PLANNER_PARAMS.defaultHorizon - 1);

  // Two gameweeks left in the season: a five gameweek horizon is impossible and
  // must be clamped rather than projecting fixtures that do not exist.
  const late = world({ xp: baseXp, gw: RULES.totalEvents - 1 });
  const clamped = await run(late, { horizon: 5 });
  assert.equal(clamped.current.horizon, 2);
  assert.equal(clamped.future.length, 1);
  assert.equal(clamped.future[0].gw, RULES.totalEvents);
});

test('later gameweeks are discounted, and the discount is a configurable parameter', async () => {
  // 310 delivers 10 extra points in the gameweek being planned. 311 delivers
  // 10.5, four gameweeks later. Undiscounted, 311 is the better buy. Under the
  // default decay a point four weeks out is worth about half of one now, so 310
  // wins.
  const xp = (id, gw) => {
    if (id === 310) return gw === GW ? 11 : 1;
    if (id === 311) return gw === GW + 4 ? 11.5 : 1;
    return baseXp(id);
  };
  const w = world({ xp });

  // maxHits 0 in both runs so exactly one transfer is on the table and the only
  // thing being measured is which of the two candidates the horizon prefers.
  const discounted = await run(w, { horizon: 5, maxHits: 0 });
  assert.deepEqual(discounted.current.transfersIn, [310], 'points four weeks out are worth less than points this week');

  const undiscounted = await run(w, { horizon: 5, maxHits: 0, discount: 1 });
  assert.deepEqual(undiscounted.current.transfersIn, [311], 'with no discounting the bigger later return wins');

  assert.equal(discounted.dataStatus.discount, RISK_PROFILES.balanced.discount);
  assert.equal(undiscounted.dataStatus.discount, 1);
  assert.ok(
    undiscounted.current.xPointsHorizon > discounted.current.xPointsHorizon,
    'an undiscounted horizon total is strictly larger',
  );
});

// ---------------------------------------------------------------------------
// Risk profiles
// ---------------------------------------------------------------------------

test('the three risk profiles behave measurably differently and the default needs no configuration', async () => {
  const xp = (id, gw) => {
    if (id === 310 || id === 311) return 9;
    if (id === 305 || id === 403) return 0.2;
    return baseXp(id);
  };
  const w = world({ xp, squad: { freeTransfers: 1, bankTenths: 40 } });

  const [conservative, balanced, aggressive, dflt] = await Promise.all([
    run(w, { risk: 'conservative' }),
    run(w, { risk: 'balanced' }),
    run(w, { risk: 'aggressive' }),
    run(w, {}),
  ]);

  assert.equal(conservative.dataStatus.risk, 'conservative');
  assert.equal(dflt.dataStatus.risk, 'balanced', 'no risk option means balanced');

  // Transfers taken: the profiles disagree about the hit, which is the decision
  // the profile exists to move.
  assert.equal(conservative.current.hits, 0);
  assert.equal(aggressive.current.hits, 1);
  assert.ok(aggressive.current.transferCount > conservative.current.transferCount);

  // And they disagree about how far ahead to trust the model.
  assert.equal(conservative.dataStatus.discount, RISK_PROFILES.conservative.discount);
  assert.equal(balanced.dataStatus.discount, RISK_PROFILES.balanced.discount);
  assert.equal(aggressive.dataStatus.discount, RISK_PROFILES.aggressive.discount);
  assert.ok(RISK_PROFILES.conservative.discount < RISK_PROFILES.aggressive.discount);

  // The default is the balanced profile in every respect, not merely in name.
  const strip = b => JSON.stringify({ ...b.current, computedAt: null, durationMs: 0 });
  assert.equal(strip(dflt), strip(balanced));

  // An unknown profile falls back to balanced rather than throwing.
  const nonsense = await run(w, { risk: 'reckless' });
  assert.equal(nonsense.dataStatus.risk, 'balanced');
});

test('an explicit option beats the profile it came from', async () => {
  const w = world({ xp: baseXp });
  const plan = await run(w, { risk: 'conservative', discount: 0.5, maxHits: 2 });
  assert.equal(plan.dataStatus.discount, 0.5);
  assert.equal(plan.dataStatus.risk, 'conservative');
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test('the same seed and the same inputs produce the same plan', async () => {
  const xp = (id, gw) => (id === 310 ? 8 : id === 311 ? 7.9 : baseXp(id));
  const w = world({ xp });

  const a = await run(w, { seed: 7 });
  const b = await run(w, { seed: 7 });

  const strip = (bundle) => JSON.stringify({
    current: { ...bundle.current, computedAt: null, durationMs: 0 },
    future: bundle.future.map(p => ({ ...p, computedAt: null, durationMs: 0 })),
  });
  assert.equal(strip(a), strip(b));
  assert.deepEqual(a.current.alternatives, b.current.alternatives);
});

// ---------------------------------------------------------------------------
// Current versus future
// ---------------------------------------------------------------------------

test('the current recommendation and the projected plans are distinguished, and the projections are marked less certain', async () => {
  const xp = (id, gw) => (id === 310 ? 8.5 : baseXp(id));
  const w = world({ xp });
  const bundle = await run(w, { horizon: 5 });

  assert.equal(bundle.current.gw, GW);
  assert.equal(bundle.current.certainty, 'current');
  assert.equal(bundle.current.confidence, 1);

  assert.deepEqual(bundle.future.map(p => p.gw), [GW + 1, GW + 2, GW + 3, GW + 4]);
  const discount = RISK_PROFILES.balanced.discount;
  bundle.future.forEach((plan, k) => {
    assert.equal(plan.certainty, 'projected');
    assert.ok(Math.abs(plan.confidence - Math.pow(discount, k + 1)) < 1e-12, `confidence at +${k + 1}`);
    assert.ok(plan.confidence < 1, 'a projected gameweek is never as certain as this one');
    if (k > 0) assert.ok(plan.confidence < bundle.future[k - 1].confidence, 'certainty decays with distance');
    const projected = plan.explanation.bullets.find(b => b.code === 'projected_plan');
    assert.ok(projected, 'a projected plan says so in its own explanation');
    assert.equal(projected.value, plan.confidence);
    assert.ok(projected.text.includes(`${Math.round(plan.confidence * 100)}%`));
  });

  // A projected gameweek inherits the squad the gameweek before it left behind.
  assert.deepEqual(
    [...bundle.future[0].squad].sort((a, b) => a - b),
    [...bundle.current.squad].sort((a, b) => a - b),
  );
  // And it starts from the free transfer the current plan banked, plus one.
  assert.equal(
    bundle.future[0].freeTransfersUsed + bundle.future[0].freeTransfersAfter,
    Math.min(RULES.maxFreeTransfers, bundle.current.freeTransfersAfter + 1),
  );
});

test('alternatives are ranked, subordinate and distinct from the primary recommendation', async () => {
  const xp = (id, gw) => {
    if (id === 310) return 8;
    if (id === 311) return 7.8;
    if (id === 312) return 7.6;
    return baseXp(id);
  };
  const w = world({ xp });
  const bundle = await run(w);

  assert.ok(bundle.current.alternatives.length > 0);
  assert.ok(bundle.current.alternatives.length <= PLANNER_PARAMS.maxAlternatives);
  const primaryKey = JSON.stringify([bundle.current.transfersOut, bundle.current.transfersIn, bundle.current.chip]);
  for (const alt of bundle.current.alternatives) {
    assert.notEqual(JSON.stringify([alt.transfersOut, alt.transfersIn, alt.chip]), primaryKey);
    assert.equal(typeof alt.headline, 'string');
    assert.ok(alt.headline.length > 0);
    assert.equal(alt.deltaHorizon, alt.xPointsHorizon - bundle.current.xPointsHorizon);
  }
});

// ---------------------------------------------------------------------------
// The plan's own arithmetic
// ---------------------------------------------------------------------------

test('the money ledger is consistent to the tenth', async () => {
  const xp = (id, gw) => (id === 310 ? 9 : baseXp(id));
  const w = world({ xp });
  const plan = (await run(w)).current;

  const sellingOf = id => w.squadState.picks.find(p => p.playerId === id).sellingTenths;
  assert.equal(plan.moneyInTenths, plan.transfersOut.reduce((s, id) => s + sellingOf(id), 0));
  assert.equal(plan.moneyOutTenths, plan.transfersIn.reduce((s, id) => s + w.gameState.players.get(id).nowCost, 0));
  assert.equal(plan.bankBeforeTenths, w.squadState.bankTenths);
  assert.equal(plan.bankAfterTenths, plan.bankBeforeTenths + plan.moneyInTenths - plan.moneyOutTenths);
  assert.ok(Number.isInteger(plan.bankAfterTenths), 'money is integer tenths');
  assert.ok(plan.bankAfterTenths >= 0);
  assert.equal(plan.xPointsNet, plan.xPointsGw - plan.hitCostPoints);
  assert.equal(plan.hitCostPoints, plan.hits * RULES.hitCost);
  assert.equal(plan.freeTransfersUsed, Math.min(plan.transferCount, w.squadState.freeTransfers));
});

test('rolling the transfer is a first-class answer with its own reasons', async () => {
  // Nothing on the market beats what is already owned.
  const w = world({ xp: id => (id === 305 ? 5 : baseXp(id)) });
  const plan = (await run(w)).current;

  assert.equal(plan.transferCount, 0);
  assert.equal(plan.chip, null);
  assert.equal(plan.explanation.headline, 'Roll your transfer');
  assert.ok(plan.explanation.rollReason, 'a roll carries its own reasoning');
  assert.ok(plan.explanation.rollReason.value > 0, 'and a real value for the banked transfer');
  assert.equal(plan.freeTransfersAfter, w.squadState.freeTransfers);
});

// ---------------------------------------------------------------------------
// The sample dataset, end to end through the real projection model
// ---------------------------------------------------------------------------

const SAMPLE_FILES = ['meta', 'bootstrap', 'fixtures', 'entry', 'entry-history', 'entry-transfers', 'entry-picks'];
const sampleBundle = assembleSampleBundle(Object.fromEntries(
  SAMPLE_FILES.map(name => [name, read('..', 'data', 'sample', `${name}.json`)]),
));

function sampleInputs() {
  const gameState = buildGameState(sampleBundle.bootstrap, sampleBundle.fixtures, { fetchedAt: sampleBundle.fetchedAt });
  const squadState = buildSquadState({
    entry: sampleBundle.entry,
    history: sampleBundle.history,
    transfers: sampleBundle.transfers,
    picks: sampleBundle.picks,
    gameState,
    gw: sampleBundle.planEvent,
  });
  return { gameState, squadState };
}

test('the sample dataset produces a validated plan through the real projection model', async () => {
  const { gameState, squadState } = sampleInputs();
  const stages = [];
  const bundle = await buildPlan({
    gameState,
    squadState,
    options: { horizon: 5, seed: 7 },
    onProgress: s => stages.push(s.key),
  });

  assert.deepEqual(stages, PROGRESS_STAGES.map(s => s.key));
  assert.deepEqual(bundle.validation, { ok: true, violations: [] });
  assert.equal(bundle.current.gw, sampleBundle.planEvent);
  assert.equal(bundle.current.squad.length, 15);
  assert.equal(bundle.current.startingXI.length, 11);
  assert.deepEqual(validatePlan(bundle.current, bundle.squadState, gameState, gameState.rules).violations, []);
  assert.equal(bundle.dataStatus.sample, true, 'a plan built on the ?demo=1 payload is marked as sample data');
  assert.equal(bundle.dataStatus.modelVersion, `planner-1+${bundle.projections.modelVersion}`);
  assert.ok(bundle.dataStatus.durationMs > 0);

  // The gameweek being planned has a blank two weeks later and a double three
  // weeks later, which is what makes this dataset worth running.
  // Each projected gameweek is validated inside the planner against the squad
  // state IT inherits (validating it against this week's squad would compare a
  // plan to a squad it never claimed to start from), so what is checked here is
  // that they came back legal and complete.
  assert.equal(bundle.future.length, 4);
  for (const plan of bundle.future) {
    assert.equal(plan.squad.length, 15);
    assert.equal(plan.startingXI.length, 11);
    assert.equal(plan.bench.order.length, 3);
    assert.ok(plan.startingXI.includes(plan.captain));
    assert.notEqual(plan.captain, plan.viceCaptain);
    assert.ok(plan.bankAfterTenths >= 0);
  }
});

test('live data is never marked as sample data', async () => {
  // The synthetic world is built the way live data arrives, with no sample
  // stamp anywhere, and the flag has to stay off: a fabricated squad presented
  // as the manager's own is the worst failure this app could have.
  const w = world({ xp: baseXp });
  const live = await run(w, { horizon: 2 });
  assert.equal(live.dataStatus.sample, false);

  const forced = await run(w, { horizon: 2, sample: true });
  assert.equal(forced.dataStatus.sample, true, 'an explicit option can still force it');
});

test('the sample plan is reproducible', async () => {
  const a = await buildPlan({ ...sampleInputs(), options: { horizon: 3, seed: 7 } });
  const b = await buildPlan({ ...sampleInputs(), options: { horizon: 3, seed: 7 } });
  assert.equal(
    JSON.stringify({ ...a.current, computedAt: null, durationMs: 0, explanation: null }),
    JSON.stringify({ ...b.current, computedAt: null, durationMs: 0, explanation: null }),
  );
});
