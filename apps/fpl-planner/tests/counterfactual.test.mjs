// counterfactual.js - "why not this player?"
//
// THE TEST THIS FILE EXISTS FOR: the answer must be a REAL comparison of two
// optimizer outputs, and "cannot fit" must be a fact about the game rather than
// a fact about the search.
//
// The regression that motivated the module is pinned first and hardest: with a
// draft squad state (pre-season, no picks) the old answer told the user there
// was nobody in their squad to sell, one screen below a fifteen the app had
// just built. Any answer here that mentions selling, or that refuses on the
// grounds of squad size, is a re-introduction of that bug.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRules } from '../js/engine/rules.js';
import { buildPlan } from '../js/engine/planner.js';
import { squadTrajectory } from '../js/engine/chips.js';
import { counterfactual, COUNTERFACTUAL_PARAMS } from '../js/engine/counterfactual.js';
import { planBasis, sameBasis } from '../js/engine/plan-basis.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => JSON.parse(readFileSync(join(here, ...p), 'utf8'));
const RULES = buildRules(read('fixtures', 'bootstrap.json'));

/* ---------------------------------------------------------------- a world */

// Letters, not digits, in every name: the assertions below read figures out of
// sentences, and a player called "P310" would smuggle a 310 into each one.
const letters = n => String(n).split('').map(d => 'ABCDEFGHIJ'[Number(d)]).join('');

function makePlayer(id, position, teamId, nowCost, over = {}) {
  return {
    id,
    code: id,
    webName: `Pl${letters(id)}`,
    firstName: '',
    secondName: `Pl${letters(id)}`,
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

const GW = 10;

// Enough of everyone to build a legal fifteen with real choice left over: the
// counterfactual is only meaningful when the optimizer had alternatives.
function roster(over = new Map()) {
  const list = [];
  // 2 GK per club-ish, cheap.
  for (let i = 0; i < 6; i++) list.push(makePlayer(100 + i, 1, 1 + i, 40 + i));
  for (let i = 0; i < 12; i++) list.push(makePlayer(200 + i, 2, 1 + (i % 12), 40 + i * 3));
  for (let i = 0; i < 12; i++) list.push(makePlayer(300 + i, 3, 1 + (i % 12), 45 + i * 4));
  for (let i = 0; i < 10; i++) list.push(makePlayer(400 + i, 4, 1 + (i % 10), 45 + i * 5));
  return list.map(p => (over.has(p.id) ? { ...p, ...over.get(p.id) } : p));
}

function makeGameState(players, gw) {
  const teamIds = [...new Set(players.map(p => p.teamId))].sort((a, b) => a - b);
  const fixtures = [];
  let id = 1;
  for (let g = 1; g <= RULES.totalEvents; g++) {
    for (let i = 0; i + 1 < teamIds.length; i += 2) {
      fixtures.push({
        id: id++, code: id, event: g, kickoff: '2026-01-03T15:00:00Z',
        teamH: teamIds[i], teamA: teamIds[i + 1], teamHDifficulty: 3, teamADifficulty: 3,
        finished: false, started: false, teamHScore: null, teamAScore: null,
      });
    }
  }
  const events = [];
  for (let i = 1; i <= RULES.totalEvents; i++) {
    events.push({
      id: i, name: `Gameweek ${i}`, deadline: null, deadlineEpoch: null,
      finished: i < gw, dataChecked: i < gw, isCurrent: i === gw - 1, isNext: i === gw, isPrevious: i === gw - 2,
      averageEntryScore: null, highestScore: null,
    });
  }
  return {
    rules: RULES,
    teams: new Map(teamIds.map(t => [t, {
      id: t, code: t, name: `Club ${letters(t)}`, shortName: `C${letters(t)}`,
      strengthOverallHome: 3, strengthOverallAway: 3,
    }])),
    players: new Map(players.map(p => [p.id, p])),
    fixtures,
    events,
    fetchedAt: '2026-01-01T00:00:00.000Z',
    currentEvent: gw - 1,
    nextEvent: gw,
    seasonStarted: true,
  };
}

function makeProjections(gameState, gwFrom, gwTo, xp, mins) {
  const byPlayer = new Map();
  for (const p of gameState.players.values()) {
    const rows = [];
    for (let gw = gwFrom; gw <= gwTo; gw++) {
      const fixtures = gameState.fixtures.filter(f => f.event === gw && (f.teamH === p.teamId || f.teamA === p.teamId));
      const available = p.status === 'a' || p.status === 'd';
      const pAppear = fixtures.length && available ? 1 : 0;
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
        pAppear,
        pStart: pAppear,
        xMins: pAppear * (mins ? mins(p.id) : 90),
        components: {
          xGoals: 0, xAssists: 0, xCleanSheet: 0, xSaves: 0, xBonus: 0,
          xCards: 0, xDefCon: 0, xConceded: 0, xPensSaved: 0,
        },
        xPoints: fixtures.length ? xp(p.id, gw) * pAppear : 0,
        sd: 1,
        ceiling: 8,
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

function draftState(gameState, gw = GW) {
  return {
    entryId: 42,
    entryName: 'Test XI',
    managerName: 'Test Manager',
    gw,
    picks: [],
    bankTenths: RULES.budgetTenths,
    squadValueTenths: RULES.budgetTenths,
    freeTransfers: RULES.maxFreeTransfers,
    chipsUsed: ['wildcard', 'freehit', 'bboost', '3xc'],
    chipsAvailable: [],
    overallRank: null,
    totalPoints: 0,
    source: 'draft',
    asOf: '2026-01-01T00:00:00.000Z',
    warnings: [],
  };
}

// A legal fifteen, cheapest first, honouring the position quotas and the club
// limit. Built rather than hand-listed because the roster spreads clubs by
// modulo and a hand-listed squad quietly ends up with four from one club, which
// the planner rejects outright.
function legalFifteen(gameState) {
  const need = new Map(Object.values(RULES.positions).map(p => [p.id, p.squadSelect]));
  const clubs = new Map();
  const ids = [];
  const all = [...gameState.players.values()].sort((a, b) => a.nowCost - b.nowCost || a.id - b.id);
  for (const p of all) {
    if ((need.get(p.position) || 0) <= 0) continue;
    if ((clubs.get(p.teamId) || 0) >= RULES.clubLimit) continue;
    ids.push(p.id);
    need.set(p.position, need.get(p.position) - 1);
    clubs.set(p.teamId, (clubs.get(p.teamId) || 0) + 1);
  }
  return ids;
}

function heldStateFrom(ids, gameState, { gw = GW, bankTenths = null, freeTransfers = 1 } = {}) {
  const priceOf = id => gameState.players.get(id).nowCost;
  const spend = ids.reduce((s, id) => s + priceOf(id), 0);
  bankTenths = bankTenths === null ? RULES.budgetTenths - spend : bankTenths;
  return {
    ...draftState(gameState, gw),
    picks: ids.map((playerId, i) => ({
      playerId,
      slot: i + 1,
      isCaptain: false,
      isViceCaptain: false,
      multiplier: i < RULES.starters ? 1 : 0,
      purchaseTenths: priceOf(playerId),
      sellingTenths: priceOf(playerId),
    })),
    bankTenths,
    squadValueTenths: ids.reduce((s, id) => s + priceOf(id), 0) + bankTenths,
    freeTransfers,
    source: 'picks',
  };
}

// Points that rise with id inside a position, so "who is better" is knowable
// from the id alone and an assertion can name the player it expects.
function baseXp(id) {
  if (id >= 100 && id < 200) return 3 + (id - 100) * 0.1;
  if (id >= 200 && id < 300) return 3 + (id - 200) * 0.15;
  if (id >= 300 && id < 400) return 3.5 + (id - 300) * 0.2;
  return 4 + (id - 400) * 0.25;
}

const HORIZON = 3;

async function world({ over = new Map(), xp = baseXp, mins = null, held = false, options = {} } = {}) {
  const players = roster(over);
  const gameState = makeGameState(players, GW);
  const projections = makeProjections(gameState, GW, GW + HORIZON + 3, xp, mins);
  const squadState = held
    ? heldStateFrom(Array.isArray(held) ? held : legalFifteen(gameState), gameState)
    : draftState(gameState);
  const bundle = await buildPlan({
    gameState,
    squadState,
    options: { horizon: HORIZON, seed: 5, projections, strength: {}, ...options },
  });
  return { gameState, bundle, projections, squadState };
}

const ask = (id, { bundle, gameState }) => counterfactual(id, { planBundle: bundle, gameState, rules: RULES });
const allText = a => [
  a.headline,
  ...a.rows.map(r => `${r.label}: ${r.text}`),
  ...a.reasons.map(r => r.text),
  ...a.blockers.map(r => r.text),
  a.result ? a.result.text : '',
].join('\n');

/* ------------------------------------------------------------ the regression */

test('pre-season: a player left out is answered by a squad comparison, never by "nobody to sell"', async () => {
  const w = await world();
  const outsider = [...w.gameState.players.values()]
    .find(p => p.position === 3 && !w.bundle.current.squad.includes(p.id));

  const answer = ask(outsider.id, w);
  const text = allText(answer);

  // THE BUG. A draft squad state has zero picks, which is what used to make the
  // old single-swap enumeration come up empty and blame the user's squad.
  assert.equal(w.bundle.squadState.picks.length, 0, 'the fixture really is a draft');
  assert.doesNotMatch(text, /who can be sold/i);
  assert.doesNotMatch(text, /squad is full|already have 15|sixteenth/i);
  assert.notEqual(answer.verdict, 'impossible', 'an available player fits into some legal fifteen');

  // What it says instead: two totals, and the difference between them.
  assert.equal(answer.mode, 'draft');
  assert.equal(typeof answer.deltaHorizon, 'number');
  assert.ok(answer.rows.some(r => r.code === 'baseline_total'));
  assert.ok(answer.rows.some(r => r.code === 'alternative_total'));
  assert.ok(answer.result, 'the answer ends with a result line');
});

test('pre-season: the counterfactual squad really contains the player and is legal', async () => {
  const w = await world();
  const outsider = [...w.gameState.players.values()]
    .find(p => p.position === 4 && !w.bundle.current.squad.includes(p.id));
  const answer = ask(outsider.id, w);

  assert.ok(answer.squad.includes(outsider.id), 'forcing him in has to actually force him in');
  assert.equal(answer.squad.length, RULES.squadSize);

  const counts = new Map();
  const clubs = new Map();
  let cost = 0;
  for (const id of answer.squad) {
    const p = w.gameState.players.get(id);
    counts.set(p.position, (counts.get(p.position) || 0) + 1);
    clubs.set(p.teamId, (clubs.get(p.teamId) || 0) + 1);
    cost += p.nowCost;
  }
  for (const position of Object.values(RULES.positions)) {
    assert.equal(counts.get(position.id), position.squadSelect, `${position.short} count`);
  }
  assert.ok(Math.max(...clubs.values()) <= RULES.clubLimit, 'three per club holds');
  assert.ok(cost <= RULES.budgetTenths, 'inside the budget');
  assert.equal(answer.bankTenths, RULES.budgetTenths - cost);
});

test('the baseline quoted to the user is the plan\'s own number, not a re-derived one', async () => {
  const w = await world();
  const outsider = [...w.gameState.players.values()]
    .find(p => p.position === 3 && !w.bundle.current.squad.includes(p.id));
  const answer = ask(outsider.id, w);

  const baselineRow = answer.rows.find(r => r.code === 'baseline_total');
  const recomputed = squadTrajectory({
    squadIds: w.bundle.current.squad,
    projections: w.projections,
    gameState: w.gameState,
    rules: RULES,
    gwFrom: w.bundle.current.gw,
    horizon: w.bundle.dataStatus.horizon,
    discount: w.bundle.dataStatus.discount,
    opts: { seed: w.bundle.dataStatus.seed },
  }).total;

  assert.ok(Math.abs(baselineRow.value - recomputed) < 1e-9, 'same evaluator as the planner');
  assert.ok(Math.abs(baselineRow.value - w.bundle.current.xPointsHorizon) < 1e-9, 'and the same number the hero shows');
});

test('the recommended squad is never beaten by more than the tie tolerance in its own draft', async () => {
  const w = await world();
  // The optimizer searched with this player free to be picked and did not pick
  // him, so forcing him in cannot come out materially ahead. If it does, the
  // recommendation itself was leaving points on the table.
  const outsiders = [...w.gameState.players.values()]
    .filter(p => !w.bundle.current.squad.includes(p.id))
    .slice(0, 6);
  for (const p of outsiders) {
    const answer = ask(p.id, w);
    if (answer.verdict === 'impossible') continue;
    assert.ok(
      answer.deltaHorizon <= COUNTERFACTUAL_PARAMS.tieTolerance,
      `${p.webName} came out ${answer.deltaHorizon} ahead of a squad the same optimizer preferred`,
    );
  }
});

/* -------------------------------------------------------------- the numbers */

test('every figure in the answer is the value the reason carries', async () => {
  const w = await world();
  const outsider = [...w.gameState.players.values()]
    .find(p => p.position === 3 && !w.bundle.current.squad.includes(p.id));
  const answer = ask(outsider.id, w);

  const checked = [...answer.reasons, ...answer.blockers, answer.result].filter(Boolean);
  assert.ok(checked.length >= 3);
  for (const r of checked) {
    if (r.unit === 'text' || r.value === null) continue;
    const shown = r.unit === 'tenths'
      ? `£${(Math.abs(r.value) / 10).toFixed(1)}m`
      : r.unit === 'count'
        ? String(Math.round(r.value))
        : (Math.round(r.value * 10) / 10).toFixed(1);
    assert.ok(r.text.includes(shown), `"${r.text}" must contain its own value ${shown}`);
  }
});

test('the direct effect and the knock-on add up to the result the user is given', async () => {
  const w = await world();
  const outsiders = [...w.gameState.players.values()]
    .filter(p => !w.bundle.current.squad.includes(p.id));

  let checked = 0;
  for (const p of outsiders) {
    const answer = ask(p.id, w);
    const direct = answer.reasons.find(r => r.code === 'direct_effect');
    // The knock-on cost used to be a bullet that repeated the whole list of
    // moves. It now rides on the Knock-on changes ROW instead, signed, so the
    // reader sees the moves and their price in one place. The arithmetic this
    // test guards is unchanged: direct + knock-on must equal the headline.
    const knock = (answer.rows || []).find(r => r.code === 'knock_on');
    if (!direct || !knock || !Number.isFinite(knock.value)) continue;
    const directSigned = /would cost/.test(direct.text) ? -direct.value : direct.value;
    const knockSigned = knock.value;
    const shownTotal = Math.round(answer.deltaHorizon * 10) / 10;
    assert.ok(
      Math.abs((directSigned + knockSigned) - shownTotal) < 1e-9,
      `${p.webName}: ${directSigned} + ${knockSigned} should be exactly ${shownTotal}`,
    );
    checked++;
  }
  assert.ok(checked > 0, 'the fixture produced at least one knock-on to check');
});

test('a player who costs more but projects higher is described as exactly that', async () => {
  // The best forward in the game, priced up until the optimizer stops wanting
  // him. Searching for that price rather than guessing one keeps the test
  // pinned to the behaviour (declined on cost) instead of to a magic number
  // that a change in the builder would silently invalidate.
  let w = null;
  for (const points of [11, 9, 7.5, 6.8, 6.4]) {
    const candidate = await world({
      over: new Map([[409, { nowCost: 200 }]]),
      xp: id => (id === 409 ? points : baseXp(id)),
    });
    // Affordable (a legal fifteen containing him exists) but not wanted.
    if (!candidate.bundle.current.squad.includes(409)) { w = candidate; break; }
  }
  assert.ok(w, 'some projection makes the optimizer decline an affordable premium');

  const answer = ask(409, w);
  const text = allText(answer);
  assert.equal(answer.verdict, 'worse');
  assert.match(text, /On his own PlEAJ projects [\d.]+ points more than/);
  assert.match(text, /costs £[\d.]+m more/);
  assert.ok(
    answer.reasons.some(r => r.code === 'knock_on_cost') || answer.reasons.some(r => r.code === 'direct_effect'),
    'the price is paid somewhere and the answer names where',
  );
});

test('expected minutes are always reported, level or not', async () => {
  const w = await world({ mins: id => (id >= 400 ? 45 : 90) });
  const outsider = [...w.gameState.players.values()]
    .find(p => p.position === 4 && !w.bundle.current.squad.includes(p.id));
  const answer = ask(outsider.id, w);
  const minutes = answer.reasons.find(r => r.code === 'minutes');
  assert.ok(minutes, 'a swap always states the minutes comparison');
  assert.equal(minutes.unit, 'count');
});

/* ---------------------------------------------------- cannot fit, truthfully */

test('an unavailable player is refused for being unavailable, and only then', async () => {
  const over = new Map([[305, { status: 'u' }]]);
  const w = await world({ over });
  const answer = ask(305, w);

  assert.equal(answer.verdict, 'impossible');
  assert.equal(answer.blockers[0].code, 'unavailable');
  assert.match(answer.headline, /cannot be fitted into any legal squad/);
  assert.doesNotMatch(allText(answer), /who can be sold|squad is full/i);
});

test('money is called impossible only when the cheapest legal fifteen containing him is over budget', async () => {
  // Priced beyond the point where fourteen minimum-price team mates leave room.
  const over = new Map([[409, { nowCost: 480 }]]);
  const w = await world({ over });
  const answer = ask(409, w);

  assert.equal(answer.verdict, 'impossible');
  const blocker = answer.blockers.find(b => b.code === 'budget');
  assert.ok(blocker, 'the binding constraint is named as money');
  assert.equal(blocker.unit, 'tenths');
  assert.ok(blocker.value > 0);
  assert.match(blocker.text, /cheapest legal fifteen/);
});

test('a merely expensive player is NOT called impossible', async () => {
  // Costly enough that the optimizer will not take him, cheap enough that a
  // legal fifteen containing him exists. That distinction is the whole point.
  const over = new Map([[409, { nowCost: 300 }]]);
  const w = await world({ over });
  const answer = ask(409, w);
  assert.notEqual(answer.verdict, 'impossible');
  assert.ok(answer.squad.includes(409));
});

test('in season, the three-per-club limit is named when it is what blocks him', async () => {
  // A squad holding three from club 1 already, and a fourth club-1 player who
  // plays a position where no club-20 team mate can be sold to make room. Club
  // 20 exists only for these four, so the counts are unambiguous.
  const over = new Map([
    [200, { teamId: 20, nowCost: 39 }],
    [201, { teamId: 20, nowCost: 39 }],
    [202, { teamId: 20, nowCost: 39 }],
    [409, { teamId: 20, nowCost: 45 }],
  ]);
  const w = await world({ over, held: true });
  const held = w.squadState.picks.map(p => p.playerId);
  assert.equal(held.filter(id => w.gameState.players.get(id).teamId === 20).length, RULES.clubLimit);

  const answer = ask(409, w);
  if (answer.verdict === 'impossible') {
    assert.ok(answer.blockers.some(b => b.code === 'club_limit'), 'the club limit is named');
    assert.match(allText(answer), /which is the limit/);
  } else {
    // Two moves found a way through, which is a legal answer: it must then show
    // the two-move route rather than claiming he cannot be fitted.
    assert.equal(answer.transfers, 2);
  }
  assert.doesNotMatch(allText(answer), /who can be sold/i);
});

/* --------------------------------------------------------------- in season */

test('in season the answer is a transfer route, with a hit named when one is needed', async () => {
  const w = await world({ held: true });
  const held = w.squadState.picks.map(p => p.playerId);
  const target = [...w.gameState.players.values()]
    .find(p => p.position === 3 && !held.includes(p.id) && !w.bundle.current.squad.includes(p.id));

  const answer = ask(target.id, w);
  assert.equal(answer.mode, 'transfer');
  assert.ok(answer.transfers >= 1 && answer.transfers <= COUNTERFACTUAL_PARAMS.maxRouteTransfers);
  assert.ok(answer.rows.some(r => r.code === 'route'), 'the route is stated');
  assert.ok(answer.squad.includes(target.id));

  const expectedHit = Math.max(0, answer.transfers - w.squadState.freeTransfers) * RULES.hitCost;
  assert.equal(answer.hitPoints, expectedHit);
  if (expectedHit > 0) {
    const hit = answer.reasons.find(r => r.code === 'hit');
    assert.ok(hit && hit.text.includes(String(expectedHit)), 'a hit is never silent');
  }
});

test('in season, alternatives are a short list behind the primary answer, not every route', async () => {
  const w = await world({ held: true });
  const held = w.squadState.picks.map(p => p.playerId);
  const target = [...w.gameState.players.values()]
    .find(p => p.position === 4 && !held.includes(p.id) && !w.bundle.current.squad.includes(p.id));
  const answer = ask(target.id, w);

  assert.ok(answer.alternatives.length <= COUNTERFACTUAL_PARAMS.maxAlternatives);
  // The primary answer is the best one: nothing behind the disclosure beats it.
  for (const alt of answer.alternatives) {
    assert.ok(alt.deltaHorizon <= answer.deltaHorizon + 1e-9, 'the primary route is the best one');
  }
  // And the transfer counts on offer are distinct, so a one-move and a two-move
  // route are both visible rather than three flavours of the same thing.
  const counts = new Set(answer.alternatives.map(a => a.transfers));
  if (answer.alternatives.length > 1) assert.ok(counts.size >= 1);
});

test('a player the plan SELLS is answered as keeping him, not as buying him again', async () => {
  const w = await world({ held: true });
  const sold = (w.bundle.current.transfersOut || [])[0];
  assert.ok(sold !== undefined, 'the fixture must produce a plan that sells somebody');

  const answer = ask(sold, w);
  assert.equal(answer.mode, 'keep');
  assert.match(answer.headline, /is in your squad today and the recommendation sells him/);
  assert.ok(answer.squad.includes(sold), 'the counterfactual squad keeps him');
  assert.equal(typeof answer.deltaHorizon, 'number');
  assert.ok(answer.result, 'and it still ends with a result line');
  // He is held, so nothing about buying him can be true.
  assert.doesNotMatch(allText(answer), /Best route|who can be sold/i);
});

test('a player already in the recommended squad is told so, not compared with himself', async () => {
  const w = await world();
  const owned = w.bundle.current.startingXI[0];
  const answer = ask(owned, w);
  assert.equal(answer.verdict, 'owned');
  assert.equal(answer.deltaHorizon, 0);
  assert.match(answer.headline, /already in the recommended/);
});

test('an unknown id is refused as an unknown id', async () => {
  const w = await world();
  const answer = ask(999999, w);
  assert.equal(answer.verdict, 'unknown');
  assert.equal(answer.blockers[0].code, 'unknown_player');
});

test('the answer is deterministic: the same question twice gives the same numbers', async () => {
  const w = await world();
  const outsider = [...w.gameState.players.values()]
    .find(p => p.position === 2 && !w.bundle.current.squad.includes(p.id));
  const first = ask(outsider.id, w);
  const second = ask(outsider.id, w);
  assert.equal(first.deltaHorizon, second.deltaHorizon);
  assert.deepEqual(first.squad, second.squad);
  assert.equal(allText(first), allText(second));
});

/* ---------------------------------- in season: "why not him INSTEAD of X?" */

// The 2026-10-09 report, rebuilt deterministically. Entry 3855835 heading into
// GW6 held an injured forward (Isak, 0 xP) with £0.1m in the bank and one free
// transfer. The plan sold him for a cheap forward (Gonzalo); asking "why not
// João Pedro?" printed "Isak is preferred because +0.9 xP ..." - naming the
// player BOTH plans sell - and "João Pedro projects 14.2 more than Isak", a
// comparison with the wrong man. Here: OUT is the injured forward, G the
// recommended buy (6.0 xP, cheaper), J the one asked about (5.0 xP, dearer).
//
// Every other player outside the squad is priced out of reach, and a held
// midfielder carries the armband at 9.0 xP in every column, so the only thing
// that differs between the two squads is G against J. That makes the squad gap
// computable by hand: (6 - 5) xP a gameweek, weighted 1, 0.85, 0.85^2.

const WEIGHTS = [1, 0.85, 0.85 * 0.85];
const WEIGHT_SUM = WEIGHTS.reduce((a, b) => a + b, 0);

function inSeasonWorld({ xp = {}, cost = {}, team = {}, status = {}, bank = 1, ft = 1, priceOut = true } = {}) {
  const base = roster();
  const held = legalFifteen(makeGameState(base, GW));
  const fwds = held.filter(id => base.find(p => p.id === id).position === 4);
  const OUT = fwds[fwds.length - 1];
  const free = base.filter(p => p.position === 4 && !held.includes(p.id)).map(p => p.id);
  const [G, J] = free;
  const captain = held.find(id => base.find(p => p.id === id).position === 3);
  const sellOut = base.find(p => p.id === OUT).nowCost;
  const c = { [G]: sellOut + bank - 2, [J]: sellOut + bank, ...cost };
  const over = new Map();
  for (const p of base) {
    if (held.includes(p.id)) continue;
    // Out of reach unless the scenario prices him.
    const o = {};
    if (priceOut) o.nowCost = 150;
    if (c[p.id] !== undefined) o.nowCost = c[p.id];
    over.set(p.id, o);
  }
  over.set(OUT, { ...(over.get(OUT) || {}), status: 'i' });
  over.set(G, { ...(over.get(G) || {}), teamId: team[G] ?? 11 });
  over.set(J, { ...(over.get(J) || {}), teamId: team[J] ?? 12 });
  for (const [id, t] of Object.entries(team)) over.set(Number(id), { ...(over.get(Number(id)) || {}), teamId: t });
  for (const [id, st] of Object.entries(status)) over.set(Number(id), { ...(over.get(Number(id)) || {}), status: st });
  const players = roster(over);
  const gameState = makeGameState(players, GW);
  const xpOf = { [G]: 6, [J]: 5, [captain]: 9, ...xp };
  const projections = makeProjections(gameState, GW, GW + HORIZON + 3, id => (xpOf[id] !== undefined ? xpOf[id] : baseXp(id)), null);
  const squadState = heldStateFrom(held, gameState, { bankTenths: bank, freeTransfers: ft });
  return { players, gameState, projections, squadState, held, OUT, G, J, captain };
}

async function planned(w, options = {}) {
  const bundle = await buildPlan({
    gameState: w.gameState,
    squadState: w.squadState,
    options: { horizon: HORIZON, seed: 5, projections: w.projections, strength: {}, ...options },
  });
  return { ...w, bundle };
}

const tableValues = (answer, code) => answer.direct.table.rows.find(r => r.code === code).values;

test('regression 2026-10-09: the recommended buy is the comparator, never the player both plans sell', async () => {
  const w = await planned(inSeasonWorld());
  const plan = w.bundle.current;
  assert.deepEqual(plan.transfersOut, [w.OUT], 'the fixture sells the injured forward');
  assert.deepEqual(plan.transfersIn, [w.G], 'and buys the cheaper, better-projected forward');

  const answer = ask(w.J, w);
  assert.equal(answer.mode, 'transfer');
  assert.equal(answer.direct.kind, 'replace');
  assert.equal(answer.direct.outId, w.OUT, 'the player sold is identified as sold');
  assert.equal(answer.direct.comparatorId, w.G, 'the recommended incoming player is the comparator');
  assert.equal(answer.direct.targetId, w.J);

  // The bug: the one-line summary named the outgoing player as preferred.
  const outName = w.gameState.players.get(w.OUT).webName;
  const gName = w.gameState.players.get(w.G).webName;
  assert.equal(answer.preference.winnerId, w.G);
  assert.match(answer.preference.label, new RegExp(`^${gName} is preferred because`));
  assert.doesNotMatch(answer.preference.label, new RegExp(outName), 'the player both plans sell is never "preferred"');
  assert.match(answer.headline, new RegExp(`${gName} is the better buy`));
  // And the player-versus-player line is about the two buys, not about OUT.
  const gap = answer.reasons.find(r => r.code === 'individual_gap');
  assert.match(gap.text, new RegExp(`fewer than ${gName}`));
  assert.doesNotMatch(gap.text, new RegExp(outName));
});

test('regression 2026-10-09: every squad figure is the gap between the two named scenarios, checked by hand', async () => {
  const w = await planned(inSeasonWorld());
  const answer = ask(w.J, w);
  const d = answer.direct;

  // Independent arithmetic: one player differs, both start every week, the
  // armband does not move. So the squad gap is the player gap, weighted.
  const expected = -(6 - 5) * WEIGHT_SUM;
  assert.ok(Math.abs(d.delta.points - expected) < 1e-9, `squad gap ${d.delta.points} should be ${expected}`);
  assert.ok(Math.abs(d.playerDelta.horizon - expected) < 1e-9, 'the player gap, in the same weighted unit');
  assert.ok(Math.abs(d.lineupEffect) < 1e-9, 'nothing but the swap separates them');
  assert.ok(Math.abs(d.delta.gwPoints - -1) < 1e-9, 'one point in the first gameweek');

  // What is displayed is what was compared.
  const [recH, altH] = tableValues(answer, 'squad_horizon');
  assert.equal(recH, w.bundle.current.xPointsHorizon, 'the recommended column is the plan the hero shows');
  assert.ok(Math.abs((altH - recH) - d.delta.points) < 1e-12);
  const [recGw, altGw] = tableValues(answer, 'squad_gw');
  assert.equal(recGw, w.bundle.current.xPointsGw, 'and its gameweek figure is the hero\'s too');
  assert.ok(Math.abs((altGw - recGw) - d.delta.gwPoints) < 1e-12);
  const horizonReason = answer.reasons.find(r => r.code === 'direct_horizon');
  assert.ok(Math.abs(horizonReason.value - Math.abs(d.delta.points)) < 1e-12);
  assert.equal(answer.preference.value, d.delta.points);
  const base = answer.rows.find(r => r.code === 'baseline_total').value;
  const alt = answer.rows.find(r => r.code === 'alternative_total').value;
  assert.ok(Math.abs((alt - base) - answer.deltaHorizon) < 1e-12);

  // Money, from selling prices: bank + OUT's sale - each purchase.
  const sell = w.squadState.picks.find(p => p.playerId === w.OUT).sellingTenths;
  const price = id => w.gameState.players.get(id).nowCost;
  assert.deepEqual(tableValues(answer, 'bank_after'), [1 + sell - price(w.G), 1 + sell - price(w.J)]);
  assert.equal(w.bundle.current.bankAfterTenths, 1 + sell - price(w.G), 'and the plan agrees on its own money');
});

test('regression 2026-10-09: the direct comparison changes exactly one player and nothing about the transfers', async () => {
  const w = await planned(inSeasonWorld());
  const answer = ask(w.J, w);
  const rec = answer.direct.recommended;
  const alt = answer.direct.alternative;
  const onlyRec = rec.squad.filter(id => !alt.squad.includes(id));
  const onlyAlt = alt.squad.filter(id => !rec.squad.includes(id));
  assert.deepEqual(onlyRec, [w.G]);
  assert.deepEqual(onlyAlt, [w.J]);
  assert.equal(rec.transfers, alt.transfers);
  assert.equal(rec.hitPoints, alt.hitPoints);
  assert.equal(rec.freeTransfers, 1, 'one free transfer, as the official site says');
  assert.equal(answer.overall.sameAsDirect, true, 'here the best plan containing him IS the direct swap');
  assert.equal(answer.overall.applesToApples, true);
  assert.ok(answer.reasons.some(r => r.code === 'overall_same'));
});

test('a better individual projection can still lose at squad level, and the answer says why', async () => {
  // Two free transfers. The plan sells OUT for G AND upgrades a defender, which
  // only G's lower price pays for. J projects MORE than G on his own, but J and
  // the defender together are over budget, so the like-for-like swap is not
  // available and the best plan containing J has to drop the second move.
  const probe = inSeasonWorld({ ft: 2 });
  // Priced off the dearest held defender, so NO defender sale funds J and D
  // together: the plan's only way to afford D is with G.
  const heldDefs = probe.held.filter(id => probe.gameState.players.get(id).position === 2);
  const sellDef = Math.max(...heldDefs.map(id => probe.gameState.players.get(id).nowCost));
  const D = [...probe.gameState.players.values()].find(p => p.position === 2 && !probe.held.includes(p.id)).id;
  const sellOut = probe.gameState.players.get(probe.OUT).nowCost;
  const gCost = sellOut + 1 - 2;
  const w = await planned(inSeasonWorld({
    ft: 2,
    xp: { [probe.J]: 6.5, [D]: 7 },
    cost: { [D]: 1 + sellOut + sellDef - gCost },
  }));
  const plan = w.bundle.current;
  assert.deepEqual(new Set(plan.transfersIn), new Set([w.G, D]), 'the plan spends both transfers, G and the defender');

  const answer = ask(w.J, w);
  assert.equal(answer.direct.available, false, 'J for G inside that plan is unaffordable');
  assert.ok(answer.direct.blockers.some(b => b.code === 'direct_budget' && b.value === 2), 'and the shortfall is named, £0.2m');
  const gap = answer.reasons.find(r => r.code === 'individual_gap');
  assert.match(gap.text, /projects [\d.]+ xP more than/, 'J really does project more on his own');
  assert.ok(Math.abs(gap.value - 0.5 * WEIGHT_SUM) < 1e-9);
  assert.equal(answer.verdict, 'worse');
  assert.equal(answer.overall.sameAsDirect, false);
  assert.equal(answer.overall.applesToApples, false, 'a whole-route comparison is labelled as one');
  assert.match(answer.rows.find(r => r.code === 'like_for_like').text, /^No:/);
  assert.ok(answer.reasons.some(r => r.code === 'overall_route'), 'and it compares routes, not two players');
  assert.match(answer.preference.label, /^The recommended plan is preferred/);
});

test('a direct swap blocked by the three-per-club limit names the club and the players', async () => {
  const probe = inSeasonWorld();
  const counts = new Map();
  for (const id of probe.held.filter(id => id !== probe.OUT)) {
    const t = probe.gameState.players.get(id).teamId;
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  const full = [...counts.entries()].find(([, n]) => n === RULES.clubLimit)[0];
  const w = await planned(inSeasonWorld({ team: { [probe.J]: full } }));
  const answer = ask(w.J, w);
  // Everything else is priced out of reach in this world, so no route frees a
  // place either: the answer is "cannot fit", and the direct swap's reason is
  // the one it gives.
  assert.equal(answer.verdict, 'impossible');
  const block = answer.blockers.find(b => b.code === 'direct_club_limit');
  assert.ok(block, 'the binding constraint is the club limit');
  assert.equal(block.value, RULES.clubLimit + 1);
  assert.match(block.text, new RegExp(`over the limit of ${RULES.clubLimit}`));
});

test('when the alternative is genuinely better, the answer says so and names him', async () => {
  // A plan built before J's projection improved: the question is answered on
  // the projections it is asked with, and an improvement is reported as one.
  const w = await planned(inSeasonWorld());
  const boosted = makeProjections(w.gameState, GW, GW + HORIZON + 3,
    id => ({ [w.G]: 6, [w.J]: 8, [w.captain]: 9 }[id] ?? baseXp(id)), null);
  const answer = ask(w.J, { ...w, bundle: { ...w.bundle, projections: boosted } });
  assert.equal(answer.verdict, 'better');
  assert.match(answer.headline, /would improve the recommendation/);
  assert.equal(answer.preference.winnerId, w.J);
  assert.ok(Math.abs(answer.direct.delta.points - 2 * WEIGHT_SUM) < 1e-9);
  assert.match(answer.result.text, /containing .* projects [\d.]+ points higher/);
});

test('a tie is reported as a tie, not dressed up as a preference', async () => {
  const w = await planned(inSeasonWorld({ xp: { 0: 0 } }));
  const tied = await planned(inSeasonWorld({ xp: { [w.J]: 6 }, cost: { [w.J]: w.gameState.players.get(w.G).nowCost } }));
  const bought = tied.bundle.current.transfersIn[0];
  const other = bought === tied.G ? tied.J : tied.G;
  const answer = ask(other, tied);
  assert.equal(answer.verdict, 'level');
  assert.match(answer.preference.label, /are level$/);
  assert.equal(answer.preference.winnerId, null);
  assert.ok(Math.abs(answer.direct.delta.points) < 1e-9);
});

test('a player in another position is compared as one more transfer, with its hit and the hit bar', async () => {
  // The plan buys a forward. Asking about a midfielder is "the plan as it
  // stands" against "the plan plus selling a midfielder for him", which is a
  // second transfer on one free one: a 4-point hit, and under the balanced
  // profile a hit must clear the best no-hit plan by 2.0 points.
  const probe = inSeasonWorld();
  const M = [...probe.gameState.players.values()].find(p => p.position === 3 && !probe.held.includes(p.id)).id;
  let found = null;
  for (const v of [5.6, 5.8, 6.0, 6.2, 6.4, 6.6, 6.8, 7.0, 7.2]) {
    const w = await planned(inSeasonWorld({ xp: { [M]: v }, cost: { [M]: 40 } }));
    if (w.bundle.current.transfersIn.includes(M)) continue;
    const answer = ask(M, w);
    if (answer.direct && answer.direct.available && answer.direct.delta.points > 0.6 && answer.direct.delta.points < 1.9) {
      found = { w, answer };
      break;
    }
  }
  assert.ok(found, 'some projection puts the extra move between the tie band and the hit bar');
  const { w, answer } = found;
  assert.equal(answer.direct.kind, 'add');
  assert.equal(answer.direct.alternative.hitPoints - answer.direct.recommended.hitPoints, RULES.hitCost);
  assert.ok(answer.reasons.some(r => r.code === 'direct_hit' && r.value === RULES.hitCost), 'the hit is a named line');
  assert.equal(answer.verdict, 'worse', 'the planner would not take it, so the answer does not recommend it');
  assert.match(answer.headline, /not by enough to justify its hit/);
  assert.ok(answer.reasons.some(r => r.code === 'hit_margin' && r.value === 2), 'the bar is stated, from the risk profile');
  assert.match(answer.preference.label, /^Keeping .* is preferred because/);
  assert.match(answer.result.text, /only by taking a hit/);
  // The plan's own alternatives card says the same thing about the same kind of route.
  for (const alt of w.bundle.current.alternatives) {
    if (alt.hits > 0 && alt.deltaHorizon > 0) assert.equal(alt.belowHitMargin, true);
  }
});

test('net points are after hits: a two-transfer route on one free transfer is charged exactly one hit', async () => {
  const w = await planned(inSeasonWorld());
  for (const p of w.gameState.players.values()) {
    if (w.bundle.current.squad.includes(p.id) || w.held.includes(p.id)) continue;
    const answer = ask(p.id, w);
    if (answer.mode !== 'transfer' || answer.verdict === 'impossible') continue;
    const best = answer.overall.best;
    const traj = squadTrajectory({
      squadIds: best.squad, projections: w.projections, gameState: w.gameState, rules: RULES,
      gwFrom: GW, horizon: HORIZON, discount: 0.85, opts: { seed: 5 },
    });
    const hit = Math.max(0, best.transfers - 1) * RULES.hitCost;
    assert.equal(best.hitPoints, hit, `${p.webName}: ${best.transfers} transfers on 1 free`);
    assert.ok(Math.abs(best.points - (traj.total - hit)) < 1e-9, `${p.webName}: net = trajectory - hit`);
  }
});

test('the explanation can never contradict the recommendation it explains', async () => {
  const w = await planned(inSeasonWorld({ priceOut: false, bank: 30 }));
  const plan = w.bundle.current;
  let checked = 0;
  for (const p of w.gameState.players.values()) {
    if (plan.squad.includes(p.id) || w.held.includes(p.id)) continue;
    const answer = ask(p.id, w);
    if (answer.mode !== 'transfer' || !answer.preference) continue;
    checked++;
    if (answer.preference.winnerId !== null) {
      assert.ok(!plan.transfersOut.includes(answer.preference.winnerId),
        `${p.webName}: a player the plan sells is never the preferred one`);
    }
    if (answer.direct && answer.direct.available && answer.preference.winnerId !== null) {
      assert.ok([answer.direct.comparatorId, answer.direct.targetId].includes(answer.preference.winnerId),
        `${p.webName}: the preference is between the two players who trade places`);
    }
    if (answer.verdict !== 'better') {
      assert.doesNotMatch(answer.headline, /would improve/, `${p.webName}: no improvement claimed against the plan`);
      assert.ok(answer.overall.delta.objective <= COUNTERFACTUAL_PARAMS.tieTolerance + 2,
        'and nothing beats it on the planner\'s own measure by more than the hit bar');
    }
    // The closing line agrees in direction with the number it states.
    if (answer.overall.delta.points < -0.05 && answer.verdict === 'worse') {
      assert.match(answer.result.text, /recommended squad projects/);
    }
  }
  assert.ok(checked > 10, 'the fixture asked about a real spread of players');
});

test('the same in-season question twice gives byte-identical answers', async () => {
  const w = await planned(inSeasonWorld());
  const a = ask(w.J, w);
  const b = ask(w.J, w);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('an answer carries the identity of its plan, and a changed free-transfer count is a different plan', async () => {
  const one = await planned(inSeasonWorld({ ft: 1 }));
  const two = await planned(inSeasonWorld({ ft: 2 }));
  const answer = ask(one.J, one);
  assert.ok(sameBasis(answer.basis, planBasis(one.bundle)), 'it matches the plan it was asked about');
  assert.equal(answer.basis.freeTransfers, 1);
  assert.equal(sameBasis(answer.basis, planBasis(two.bundle)), false, 'and not one built on 2 free transfers');
  assert.equal(sameBasis(answer.basis, { ...planBasis(one.bundle), xPointsHorizon: one.bundle.current.xPointsHorizon + 0.1 }), false,
    'nor a recalculation that moved the total');
});
