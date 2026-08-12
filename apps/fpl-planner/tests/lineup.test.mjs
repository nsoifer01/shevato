// Starting eleven and bench order (SPEC 9 and 10).
//
// Two things are being proved here. First that the eleven is always LEGAL,
// which is the promise validate.js exists to keep, and second that it is the
// best legal eleven and not a sorted top eleven, which is checked against a
// brute-force search over every legal combination rather than against the
// optimizer's own reasoning.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRules } from '../js/engine/rules.js';
import { buildGameState } from '../js/engine/normalize.js';
import { buildStrength } from '../js/engine/strength.js';
import { buildProjections } from '../js/engine/projections.js';
import { makeRng } from '../js/engine/ml.js';
import { optimizeLineup, orderBench, legalFormations, squadHorizonValue, LINEUP_PARAMS } from '../js/engine/lineup.js';
import { PLANNER_PARAMS } from '../js/engine/planner.js';
import { validatePlan, outfieldPositionIds } from '../js/engine/validate.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => JSON.parse(readFileSync(join(here, ...p), 'utf8'));

const bootstrap = read('fixtures', 'bootstrap.json');
const rules = buildRules(bootstrap);

// --- synthetic world --------------------------------------------------------

// A fifteen in the canonical shape: 2 GKP, 5 DEF, 5 MID, 3 FWD.
const SQUAD_POSITIONS = [1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 4, 4, 4];
const squadIds = SQUAD_POSITIONS.map((_, i) => i + 1);
const positionOf = id => SQUAD_POSITIONS[id - 1];

// One row per player, one gameweek, in the ProjectionSet shape the optimizers
// consume.
function makeProjections(rows, gw = 1) {
  const byPlayer = new Map();
  for (const r of rows) byPlayer.set(r.playerId, [r]);
  return {
    gwFrom: gw,
    gwTo: gw,
    byPlayer,
    get(playerId, g) {
      const list = byPlayer.get(playerId);
      return list && g === gw ? list[0] : null;
    },
  };
}

function row(playerId, { xPoints = 0, pAppear = 1, sd = 0, ceiling = null, fixtures = [{ fixtureId: 1, fdr: 3 }] } = {}) {
  return {
    playerId,
    gw: 1,
    fixtures,
    pAppear,
    pStart: pAppear,
    xMins: 90 * pAppear,
    xPoints,
    sd,
    ceiling: ceiling === null ? xPoints * 1.8 : ceiling,
    confidence: 'high',
  };
}

// The selection score the module documents, recomputed independently so the
// brute force below is not scored by the code it is checking.
function scoreOf(r, params) {
  return r.xPoints - params.riskAversion * r.sd - params.minutesRiskWeight * (1 - r.pAppear);
}

function rowsFor(ids, projections, params, gw = 1) {
  return ids.map(id => {
    const p = projections.get(id, gw);
    return {
      id,
      position: positionOf(id),
      xPoints: p.xPoints,
      pAppear: p.pAppear,
      sd: p.sd,
      ceiling: p.ceiling,
      condPoints: p.pAppear > 0 ? p.xPoints / p.pAppear : 0,
      score: scoreOf(p, params),
    };
  });
}

function combinations(items, k) {
  const out = [];
  const cur = [];
  const walk = (start) => {
    if (cur.length === k) { out.push(cur.slice()); return; }
    for (let i = start; i < items.length; i++) {
      cur.push(items[i]);
      walk(i + 1);
      cur.pop();
    }
  };
  walk(0);
  return out;
}

function isLegalXI(combo) {
  const counts = new Map();
  for (const r of combo) counts.set(r.position, (counts.get(r.position) || 0) + 1);
  if (combo.length !== rules.starters) return false;
  return Object.values(rules.positions).every(pos => {
    const n = counts.get(pos.id) || 0;
    return n >= pos.minPlay && n <= pos.maxPlay;
  });
}

const ZERO_RISK = { riskAversion: 0, minutesRiskWeight: 0 };

// --- legal formations -------------------------------------------------------

test('legalFormations is generated from the rules, not written down', () => {
  const available = new Map([[1, 2], [2, 5], [3, 5], [4, 3]]);
  const shapes = legalFormations(rules, available)
    .map(f => outfieldPositionIds(rules).map(id => f.get(id)).join('-'))
    .sort();
  assert.deepEqual(shapes, ['3-4-3', '3-5-2', '4-3-3', '4-4-2', '4-5-1', '5-2-3', '5-3-2', '5-4-1']);
  for (const formation of legalFormations(rules, available)) {
    let total = 0;
    for (const [pos, n] of formation) {
      total += n;
      assert.ok(n >= rules.positions[pos].minPlay && n <= rules.positions[pos].maxPlay);
    }
    assert.equal(total, rules.starters);
  }
});

test('changing the rules changes the formation space', () => {
  // A made-up game: nine on the pitch, one keeper, 2-4 defenders, 4-6 attackers.
  const otherRules = {
    starters: 9,
    positions: {
      1: { id: 1, short: 'GKP', name: 'Goalkeeper', squadSelect: 2, minPlay: 1, maxPlay: 1 },
      2: { id: 2, short: 'DEF', name: 'Defender', squadSelect: 5, minPlay: 2, maxPlay: 4 },
      3: { id: 3, short: 'ATT', name: 'Attacker', squadSelect: 6, minPlay: 4, maxPlay: 6 },
    },
  };
  const shapes = legalFormations(otherRules, new Map([[1, 2], [2, 5], [3, 6]]))
    .map(f => [f.get(1), f.get(2), f.get(3)].join('-'))
    .sort();
  assert.deepEqual(shapes, ['1-2-6', '1-3-5', '1-4-4']);
});

test('a formation needing players the squad does not have is never generated', () => {
  // Only two forwards fit, so no three-forward shape may be produced.
  const available = new Map([[1, 2], [2, 5], [3, 5], [4, 2]]);
  const shapes = legalFormations(rules, available)
    .map(f => outfieldPositionIds(rules).map(id => f.get(id)).join('-'));
  assert.ok(shapes.length > 0);
  assert.ok(shapes.every(s => Number(s.split('-')[2]) <= 2));
});

// --- exactness --------------------------------------------------------------

test('the eleven is the exact optimum, matching a hand-computed answer', () => {
  // Everyone is nailed, so there is no minutes risk and no auto-substitution
  // value: the objective collapses to the sum of expected points and the best
  // legal eleven can be worked out on paper.
  //
  //   GKP 4.0 / 3.0                       -> start the 4.0
  //   DEF 6.0 5.0 4.0 1.0 1.0
  //   MID 7.0 6.5 6.0 5.5 5.0
  //   FWD 6.2 2.0 1.5
  //
  //   3-4-3  15.0 + 25.0 +  9.7 = 49.7
  //   3-5-2  15.0 + 30.0 +  8.2 = 53.2   <- best
  //   4-5-1  16.0 + 30.0 +  6.2 = 52.2
  //   4-4-2  16.0 + 25.0 +  8.2 = 49.2
  const points = [4.0, 3.0, 6.0, 5.0, 4.0, 1.0, 1.0, 7.0, 6.5, 6.0, 5.5, 5.0, 6.2, 2.0, 1.5];
  const projections = makeProjections(squadIds.map(id => row(id, { xPoints: points[id - 1] })));

  const result = optimizeLineup(squadIds, projections, 1, rules, { positionOf, ...ZERO_RISK });

  assert.equal(result.formation, '3-5-2');
  assert.deepEqual(result.startingXI, [1, 3, 4, 5, 8, 9, 10, 11, 12, 13, 14]);
  assert.ok(Math.abs(result.xPoints - 57.2) < 1e-9, `xPoints was ${result.xPoints}`);
  assert.deepEqual(result.bench, { gk: 2, order: [6, 7, 15] });
  assert.equal(result.formationsEvaluated, 8);
});

test('the eleven beats every legal combination, checked by brute force', () => {
  const rng = makeRng(20260821);
  for (let trial = 0; trial < 40; trial++) {
    const rows = squadIds.map(id => row(id, {
      xPoints: Math.round(rng() * 900) / 100,
      sd: Math.round(rng() * 300) / 100,
    }));
    const projections = makeProjections(rows);
    const result = optimizeLineup(squadIds, projections, 1, rules, { positionOf, ...ZERO_RISK });

    const all = rowsFor(squadIds, projections, ZERO_RISK);
    let best = -Infinity;
    for (const combo of combinations(all, rules.starters)) {
      if (!isLegalXI(combo)) continue;
      const total = combo.reduce((sum, r) => sum + r.score, 0);
      if (total > best) best = total;
    }
    assert.ok(
      Math.abs(result.selectionScore - best) < 1e-9,
      `trial ${trial}: optimizer ${result.selectionScore} vs brute force ${best}`,
    );
  }
});

test('the doubtful keeper starts and the nailed one covers him', () => {
  // Two keepers worth exactly the same expected points:
  //
  //   keeper 1: 4.0 expected, nailed          (4.0 whenever he plays)
  //   keeper 2: 4.0 expected, a coin flip     (8.0 whenever he plays)
  //
  // Starting the nailed keeper is worth 4.0 and nothing else, because a bench
  // keeper only ever replaces the goalkeeper and this one never goes missing.
  // Starting the coin flip is worth the same 4.0 in the mean AND turns the
  // reserve into real cover: half the time keeper 1 comes on for another 4.0.
  // Two points, and no separable score can see them, which is why the exact
  // path enumerates elevens rather than taking the best player per position.
  const rows = [
    row(1, { xPoints: 4.0, pAppear: 1 }),
    row(2, { xPoints: 4.0, pAppear: 0.5 }),
    row(3, { xPoints: 5 }), row(4, { xPoints: 5 }), row(5, { xPoints: 5 }), row(6, { xPoints: 1 }), row(7, { xPoints: 1 }),
    row(8, { xPoints: 6 }), row(9, { xPoints: 6 }), row(10, { xPoints: 6 }), row(11, { xPoints: 6 }), row(12, { xPoints: 6 }),
    row(13, { xPoints: 5 }), row(14, { xPoints: 5 }), row(15, { xPoints: 1 }),
  ];
  const projections = makeProjections(rows);

  const exact = optimizeLineup(squadIds, projections, 1, rules, { positionOf, ...ZERO_RISK });
  assert.ok(exact.startingXI.includes(2), 'the coin-flip keeper should start');
  assert.equal(exact.bench.gk, 1, 'the nailed keeper is the cover');
  assert.ok(Math.abs(exact.autosubValue - 2.0) < 1e-9, `auto-sub value was ${exact.autosubValue}`);
  assert.ok(Math.abs((exact.selectionScore + exact.autosubValue) - 61.0) < 1e-9);

  // The shortcut the fast path takes gets this wrong by two points, which is
  // the price of running it thousands of times inside the transfer search.
  const fast = optimizeLineup(squadIds, projections, 1, rules, { positionOf, ...ZERO_RISK, mode: 'fast' });
  assert.ok(fast.startingXI.includes(1));
  assert.equal(fast.bench.gk, 2);
});

test('the exact eleven matches an exhaustive search on every randomized squad', () => {
  // The real objective, eleven plus bench, brute-forced over all 550 legal
  // elevens and compared with what the optimizer returns. The generator is
  // deliberately hostile: expected points are NOT tied to minutes, so a bench
  // player can be worth far more than a starter when he plays, which is the
  // shape of squad the separable shortcut gets wrong.
  const rng = makeRng(20260810);
  const params = { riskAversion: 0.05, minutesRiskWeight: 0.35 };
  let checked = 0;

  for (let trial = 0; trial < 30; trial++) {
    const rows = squadIds.map(id => {
      const pAppear = [0, 0.25, 0.5, 0.75, 0.9, 1][Math.floor(rng() * 6)];
      const xPoints = pAppear === 0 ? 0 : Math.round(rng() * 900) / 100;
      return row(id, { xPoints, pAppear, sd: Math.round(rng() * 400) / 100 });
    });
    const projections = makeProjections(rows);
    const result = optimizeLineup(squadIds, projections, 1, rules, { positionOf, ...params });

    const all = rowsFor(squadIds, projections, params);
    let best = -Infinity;
    for (const combo of combinations(all, rules.starters)) {
      if (!isLegalXI(combo)) continue;
      const inXi = new Set(combo.map(r => r.id));
      const bench = all.filter(r => !inXi.has(r.id));
      const total = combo.reduce((sum, r) => sum + r.score, 0)
        + orderBench(combo, bench, rules, { exact: true }).autosubValue;
      if (total > best) best = total;
    }

    const got = result.selectionScore + result.autosubValue;
    assert.ok(
      Math.abs(got - best) < 1e-9,
      `trial ${trial}: optimizer ${got.toFixed(6)} vs exhaustive ${best.toFixed(6)}`,
    );
    checked++;
  }
  assert.equal(checked, 30);
});

// --- legality ---------------------------------------------------------------

function randomSquad(rng) {
  // 20 clubs, at most three players from any one of them, which is the state a
  // real squad is always in.
  const teams = [];
  const used = new Map();
  for (let i = 0; i < 15; i++) {
    let team;
    do { team = 1 + Math.floor(rng() * 20); } while ((used.get(team) || 0) >= rules.clubLimit);
    used.set(team, (used.get(team) || 0) + 1);
    teams.push(team);
  }
  const rows = squadIds.map(id => {
    // Adversarial minutes: whole blocks of the squad can be unavailable.
    const pAppear = [0, 0, 0.1, 0.35, 0.5, 0.75, 0.9, 0.98, 1][Math.floor(rng() * 9)];
    const conditional = 1 + rng() * 8;
    return row(id, {
      xPoints: Math.round(pAppear * conditional * 100) / 100,
      pAppear,
      sd: Math.round((0.5 + rng() * 3) * 100) / 100,
      fixtures: pAppear === 0 && rng() < 0.5 ? [] : [{ fixtureId: 1, fdr: 1 + Math.floor(rng() * 5) }],
    });
  });
  return { teams, rows };
}

test('500 randomized squads all yield a legal eleven and a legal bench', () => {
  const rng = makeRng(9001);
  let evaluated = 0;
  for (let trial = 0; trial < 500; trial++) {
    const { teams, rows } = randomSquad(rng);
    const players = new Map(squadIds.map(id => [id, {
      id,
      position: positionOf(id),
      teamId: teams[id - 1],
      nowCost: 40 + ((id * 7) % 60),
      status: 'a',
    }]));
    const gameState = { rules, players, teams: new Map(), fixtures: [], events: [] };
    const projections = makeProjections(rows);

    const lineup = optimizeLineup(squadIds, projections, 1, rules, { gameState });
    evaluated++;

    const cost = squadIds.reduce((sum, id) => sum + players.get(id).nowCost, 0);
    const plan = {
      gw: 1,
      chip: null,
      transfersOut: [],
      transfersIn: [],
      transferCount: 0,
      freeTransfersUsed: 0,
      hits: 0,
      hitCostPoints: 0,
      bankBeforeTenths: cost,
      moneyInTenths: 0,
      moneyOutTenths: cost,
      bankAfterTenths: 0,
      squad: squadIds,
      startingXI: lineup.startingXI,
      formation: lineup.formation,
      bench: lineup.bench,
      captain: lineup.startingXI[1],
      viceCaptain: lineup.startingXI[2],
    };
    const state = { gw: 1, picks: [], bankTenths: cost, freeTransfers: 0, chipsUsed: [] };
    const result = validatePlan(plan, state, gameState, rules);
    assert.deepEqual(result.violations, [], `trial ${trial}: ${JSON.stringify(result.violations)}`);
  }
  assert.equal(evaluated, 500);
});

test('fast mode is still legal, because the transfer search runs thousands of them', () => {
  const rng = makeRng(4242);
  for (let trial = 0; trial < 50; trial++) {
    const { rows } = randomSquad(rng);
    const projections = makeProjections(rows);
    const lineup = optimizeLineup(squadIds, projections, 1, rules, { positionOf, mode: 'fast' });
    const counts = new Map();
    for (const id of lineup.startingXI) counts.set(positionOf(id), (counts.get(positionOf(id)) || 0) + 1);
    assert.equal(lineup.startingXI.length, 11);
    for (const pos of Object.values(rules.positions)) {
      const n = counts.get(pos.id) || 0;
      assert.ok(n >= pos.minPlay && n <= pos.maxPlay, `${pos.short} ${n}`);
    }
    assert.equal(positionOf(lineup.bench.gk), 1);
    assert.equal(lineup.bench.order.length, 3);
  }
});

// --- selection is not a points sort -----------------------------------------

test('a player who cannot appear is never started over a playable alternative', () => {
  const points = new Map([
    [1, 4.0], [2, 3.0],
    [3, 5.0], [4, 4.5], [5, 4.0], [6, 3.5], [7, 3.0],
    [8, 6.0], [9, 5.5], [10, 5.0], [11, 4.5], [12, 4.0],
    [13, 5.0], [14, 4.0], [15, 3.0],
  ]);
  // Midfielder 8, the best player in the squad, is ruled out for the gameweek.
  const rows = squadIds.map(id => row(id, {
    xPoints: id === 8 ? 0 : points.get(id),
    pAppear: id === 8 ? 0 : 1,
  }));
  const lineup = optimizeLineup(squadIds, projectionsOf(rows), 1, rules, { positionOf });
  assert.ok(!lineup.startingXI.includes(8));
  assert.ok(lineup.bench.order.includes(8));
});

test('selection prices uncertainty, not expected points alone', () => {
  // Exactly one goalkeeper plays whatever the formation, and these two are the
  // same player in every respect the auto-substitution model can see: same
  // expected points, same chance of appearing, so benching either leaves
  // exactly the same cover. The only thing separating them is the spread.
  //
  //   keeper 1: 4.0 expected points, standard deviation 4.0
  //   keeper 2: 4.0 expected points, standard deviation 1.0
  //
  // A conservative manager pays for the certainty and a risk-neutral one is
  // indifferent, so the same projections give a different keeper. That is the
  // risk profile doing real work rather than decorating the output.
  const rest = [
    row(3, { xPoints: 5 }), row(4, { xPoints: 5 }), row(5, { xPoints: 5 }), row(6, { xPoints: 1 }), row(7, { xPoints: 1 }),
    row(8, { xPoints: 6 }), row(9, { xPoints: 6 }), row(10, { xPoints: 6 }), row(11, { xPoints: 6 }), row(12, { xPoints: 6 }),
    row(13, { xPoints: 5 }), row(14, { xPoints: 5 }), row(15, { xPoints: 1 }),
  ];
  const rows = [
    row(1, { xPoints: 4.0, pAppear: 0.9, sd: 4 }),
    row(2, { xPoints: 4.0, pAppear: 0.9, sd: 1 }),
    ...rest,
  ];
  const projections = projectionsOf(rows);

  for (const risk of ['conservative', 'balanced']) {
    const lineup = optimizeLineup(squadIds, projections, 1, rules, { positionOf, risk });
    assert.ok(lineup.startingXI.includes(2), `${risk} should start the steadier keeper`);
    assert.equal(lineup.bench.gk, 1);
  }

  // The aggressive profile prices no uncertainty at all, so the two are tied
  // and the deterministic tie-break (lowest id) decides.
  const aggressive = optimizeLineup(squadIds, projections, 1, rules, { positionOf, risk: 'aggressive' });
  assert.ok(aggressive.startingXI.includes(1));
  assert.equal(aggressive.bench.gk, 2);
});

function projectionsOf(rows) {
  return makeProjections(rows);
}

// --- bench order ------------------------------------------------------------

test('the bench goalkeeper slot only ever holds a goalkeeper', () => {
  const rng = makeRng(77);
  for (let trial = 0; trial < 100; trial++) {
    const { rows } = randomSquad(rng);
    const lineup = optimizeLineup(squadIds, projectionsOf(rows), 1, rules, { positionOf });
    assert.equal(positionOf(lineup.bench.gk), 1);
    for (const id of lineup.bench.order) assert.notEqual(positionOf(id), 1);
  }
});

test('bench order prefers the substitute who is actually likely to play', () => {
  // Both bench defenders can cover the one absence the eleven risks. Number 6
  // is worth 5.0 when he plays and plays two thirds of the time; number 7 is
  // worth 3.0 and plays a fifth of the time.
  const rows = [
    row(1, { xPoints: 5 }), row(2, { xPoints: 1 }),
    row(3, { xPoints: 4.0, pAppear: 0.8 }), row(4, { xPoints: 5 }), row(5, { xPoints: 5 }),
    row(6, { xPoints: 3.3, pAppear: 0.66 }), row(7, { xPoints: 0.6, pAppear: 0.2 }),
    row(8, { xPoints: 6 }), row(9, { xPoints: 6 }), row(10, { xPoints: 6 }), row(11, { xPoints: 6 }), row(12, { xPoints: 6 }),
    row(13, { xPoints: 5 }), row(14, { xPoints: 5 }), row(15, { xPoints: 1 }),
  ];
  const lineup = optimizeLineup(squadIds, projectionsOf(rows), 1, rules, { positionOf });
  assert.equal(lineup.formation, '3-5-2');
  assert.equal(lineup.bench.order[0], 6);
  assert.ok(lineup.autosubValue > 0);
});

test('a substitute who cannot legally come on is ordered behind one who can', () => {
  // A three-at-the-back eleven with a doubtful defender. FPL will not bring a
  // midfielder on for a missing defender, because two at the back is not a
  // legal team, so the bench defender covers a risk the midfielder cannot,
  // even though the midfielder is worth more when he plays.
  const rows = [
    row(1, { xPoints: 4 }),
    row(2, { xPoints: 1 }),
    // Starting defenders: three of them, one doubtful.
    row(3, { xPoints: 4 }), row(4, { xPoints: 4 }), row(5, { xPoints: 2.0, pAppear: 0.5 }),
    // Bench defenders.
    row(6, { xPoints: 1.5, pAppear: 1 }), row(7, { xPoints: 0.5, pAppear: 1 }),
    // Starting midfielders (four of them, all nailed).
    row(8, { xPoints: 6 }), row(9, { xPoints: 6 }), row(10, { xPoints: 6 }), row(11, { xPoints: 6 }),
    // Bench midfielder, worth far more than either bench defender.
    row(12, { xPoints: 5.0, pAppear: 1 }),
    // Three nailed forwards, so the shape is 3-4-3 and defence sits at its
    // minimum.
    row(13, { xPoints: 6 }), row(14, { xPoints: 6 }), row(15, { xPoints: 6 }),
  ];
  const lineup = optimizeLineup(squadIds, projectionsOf(rows), 1, rules, { positionOf, ...ZERO_RISK });
  assert.equal(lineup.formation, '3-4-3');
  assert.ok(!lineup.startingXI.includes(12), 'the fifth midfielder is the one on the bench');
  assert.equal(lineup.bench.order[0], 6, 'the bench defender covers the only absence that can happen');
  assert.ok(lineup.bench.order.indexOf(12) > lineup.bench.order.indexOf(6));

  // And the reason is the legality of the substitution, not the points: with
  // five defenders allowed to start the same bench would be ordered the other
  // way round.
  const openRules = {
    ...rules,
    positions: { ...rules.positions, 2: { ...rules.positions[2], minPlay: 1 } },
  };
  const xiRows = rowsFor([1, 3, 4, 5, 8, 9, 10, 11, 13, 14, 15], projectionsOf(rows), ZERO_RISK);
  const benchRows = rowsFor([2, 6, 7, 12], projectionsOf(rows), ZERO_RISK);
  const relaxed = orderBench(xiRows, benchRows, openRules, { exact: true });
  assert.equal(relaxed.order[0], 12, 'with three at the back legal, the midfielder can cover and is worth more');
});

test('orderBench reports the reserve keeper separately from the outfield order', () => {
  const rows = squadIds.map(id => row(id, { xPoints: 3, pAppear: 0.9 }));
  const xiRows = rowsFor([1, 3, 4, 5, 8, 9, 10, 11, 13, 14, 15], projectionsOf(rows), ZERO_RISK);
  const benchRows = rowsFor([2, 6, 7, 12], projectionsOf(rows), ZERO_RISK);
  const bench = orderBench(xiRows, benchRows, rules, { exact: true });
  assert.equal(bench.gk, 2);
  assert.deepEqual(bench.order.slice().sort((a, b) => a - b), [6, 7, 12]);
  // The reserve keeper is only worth something when the first-choice keeper
  // might not play: 10 per cent of the time, at his conditional points.
  assert.ok(Math.abs(bench.gkValue - 0.1 * 0.9 * (3 / 0.9)) < 1e-9);
  assert.ok(bench.autosubValue > bench.gkValue);
});

// --- blank gameweeks --------------------------------------------------------

test('a player with no fixture is worth nothing and does not start', () => {
  const rows = squadIds.map(id => row(id, { xPoints: 4, pAppear: 1 }));
  // Midfielder 8 and forward 13 are blank this gameweek.
  rows[7] = row(8, { xPoints: 0, pAppear: 0, fixtures: [] });
  rows[12] = row(13, { xPoints: 0, pAppear: 0, fixtures: [] });
  const lineup = optimizeLineup(squadIds, projectionsOf(rows), 1, rules, { positionOf });
  assert.ok(!lineup.startingXI.includes(8));
  assert.ok(!lineup.startingXI.includes(13));
  assert.ok(lineup.bench.order.includes(8));
  assert.ok(lineup.bench.order.includes(13));
});

test('a real blank gameweek benches the blanked club, from fixture data alone', () => {
  // The committed fixtures move one GW5 match into GW6, so clubs 4 and 6 have
  // no GW5 fixture at all and two in GW6.
  const gameState = buildGameState(
    { ...bootstrap, events: read('fixtures', 'events-in-season.json') },
    read('fixtures', 'fixtures.json'),
    { fetchedAt: '2026-09-24T10:00:00Z' },
  );
  const strength = buildStrength(gameState, { asOfGw: 5 });
  const projections = buildProjections({ gameState, strength, gwFrom: 5, gwTo: 6 });

  const blanked = [...gameState.players.values()].filter(p => p.teamId === 4 || p.teamId === 6);
  assert.ok(blanked.length >= 4, 'the fixture needs blanked players to be testable');
  for (const p of blanked) {
    const blank = projections.get(p.id, 5);
    assert.deepEqual(blank.fixtures, []);
    assert.equal(blank.xPoints, 0);
    assert.equal(blank.pAppear, 0);
    // The same players have two fixtures the following gameweek.
    assert.equal(projections.get(p.id, 6).fixtures.length, 2);
  }

  // Build a fifteen that contains one blanked player per position and check he
  // is benched in the blank and started in the double.
  const pick = (position, teamId, n) => [...gameState.players.values()]
    .filter(p => p.position === position && (teamId === null ? p.teamId !== 4 : p.teamId === teamId))
    .sort((a, b) => b.nowCost - a.nowCost)
    .slice(0, n)
    .map(p => p.id);

  const blankMid = pick(3, 4, 1)[0];
  const squad = [
    ...pick(1, null, 2),
    ...pick(2, null, 5),
    blankMid,
    ...pick(3, null, 4),
    ...pick(4, null, 3),
  ];
  assert.equal(new Set(squad).size, 15);

  const blankGw = optimizeLineup(squad, projections, 5, rules, { gameState });
  const doubleGw = optimizeLineup(squad, projections, 6, rules, { gameState });
  assert.ok(!blankGw.startingXI.includes(blankMid), 'a blanked player should not start');
  assert.ok(doubleGw.startingXI.includes(blankMid), 'the same player plays twice the week after');
});

// --- horizon value ----------------------------------------------------------

test('squadHorizonValue discounts later gameweeks and stops at the projections', () => {
  const byPlayer = new Map();
  for (const id of squadIds) {
    byPlayer.set(id, [1, 2, 3].map(() => ({
      playerId: id, gw: 1, fixtures: [{ fdr: 3 }], pAppear: 1, pStart: 1, xMins: 90,
      xPoints: 3, sd: 0, ceiling: 5, confidence: 'high',
    })));
  }
  const projections = {
    gwFrom: 1,
    gwTo: 3,
    byPlayer,
    get(id, gw) {
      const rows = byPlayer.get(id);
      const i = gw - 1;
      return rows && i >= 0 && i < rows.length ? rows[i] : null;
    },
  };
  const value = squadHorizonValue(squadIds, projections, 1, rules, { positionOf, horizon: 5, discount: 0.9, mode: 'exact' });
  assert.equal(value.byGw.length, 3, 'the horizon cannot run past the projections');
  assert.equal(value.gwTo, 3);
  assert.deepEqual(value.byGw.map(g => g.weight), [1, 0.9, 0.81]);
  // Eleven nailed players at 3 points, no auto-subs to make, plus the armband.
  const perGw = 11 * 3 + 3;
  assert.ok(Math.abs(value.total - perGw * (1 + 0.9 + 0.81)) < 1e-9, `total was ${value.total}`);
  for (const g of value.byGw) assert.equal(g.autosubValue, 0, 'nobody can be absent, so nothing is recovered');

  // The fast approximation the transfer search ranks on has to agree with the
  // exact model here exactly: no starter can be absent, so no substitute can
  // come on, and a bench credited with points it cannot score is noise the
  // search would then rank squads on.
  const fast = squadHorizonValue(squadIds, projections, 1, rules, { positionOf, horizon: 5, discount: 0.9, mode: 'fast' });
  const gap = (fast.total - value.total) / value.byGw.reduce((s, g) => s + g.weight, 0);
  assert.ok(Math.abs(gap) < 1e-9, `fast mode drifted by ${gap} points per gameweek`);
});

test('the fast bench model tracks the exact one across randomized squads', () => {
  // Fast mode drops one thing only: the check that a substitution leaves a
  // legal formation. Everything else is the same probability model, so the two
  // must stay within a small documented distance of each other. They are what
  // the transfer search filters on and what it finally decides on, and when
  // they diverge the search ranks squads it will not actually play.
  const rng = makeRng(515);
  let worst = 0;
  let bias = 0;
  let squared = 0;
  const trials = 200;

  for (let trial = 0; trial < trials; trial++) {
    const { rows } = randomSquad(rng);
    const projections = makeProjections(rows);
    const exact = optimizeLineup(squadIds, projections, 1, rules, { positionOf });
    const inXi = new Set(exact.startingXI);
    const all = rowsFor(squadIds, projections, { riskAversion: 0.05, minutesRiskWeight: 0.35 });
    const fast = orderBench(all.filter(r => inXi.has(r.id)), all.filter(r => !inXi.has(r.id)), rules, { exact: false });
    const truth = orderBench(all.filter(r => inXi.has(r.id)), all.filter(r => !inXi.has(r.id)), rules, { exact: true });

    const delta = fast.autosubValue - truth.autosubValue;
    worst = Math.max(worst, Math.abs(delta));
    bias += delta;
    squared += delta * delta;
  }

  const rmse = Math.sqrt(squared / trials);
  assert.ok(Math.abs(bias / trials) < 0.1, `fast mode is biased by ${(bias / trials).toFixed(4)} points per gameweek`);
  assert.ok(rmse < 0.35, `fast mode root mean squared error was ${rmse.toFixed(4)}`);
  assert.ok(worst < 1.5, `worst single-gameweek error was ${worst.toFixed(4)}`);
  // Fast never checks substitution legality, so where it is wrong it is
  // generous, never mean.
  assert.ok(bias >= 0);
});

test('the documented lineup parameters are exposed for the model panel', () => {
  assert.ok(LINEUP_PARAMS.riskProfiles.balanced.riskAversion > 0);
  assert.ok(LINEUP_PARAMS.riskProfiles.aggressive.minutesRiskWeight < LINEUP_PARAMS.riskProfiles.conservative.minutesRiskWeight);
  // Same number as planner.js DEFAULT_HORIZON, on purpose: a candidate must be
  // scored over the horizon the plan it lands in is scored over. Asserted as an
  // EQUALITY rather than a literal, because the failure mode is the two drifting
  // apart, which a literal in each file cannot catch.
  assert.equal(LINEUP_PARAMS.defaultHorizon, PLANNER_PARAMS.defaultHorizon);
});

test('optimizeLineup refuses to guess at positions', () => {
  const rows = squadIds.map(id => row(id, { xPoints: 3 }));
  assert.throws(
    () => optimizeLineup(squadIds, projectionsOf(rows), 1, rules, {}),
    /gameState or opts.positionOf/,
  );
});
