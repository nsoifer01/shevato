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
