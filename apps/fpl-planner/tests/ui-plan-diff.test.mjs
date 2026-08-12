import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planInputs, diffPlanVersions, actionKey, DIFF_PARAMS } from '../js/ui/plan-diff.js';
import { compactPlan, recordPlanVersion, latestVersion, MAX_VERSIONS_PER_GW, MAX_GWS_KEPT } from '../js/ui/store.js';

// WHAT THIS FILE GUARDS
//
// "The recommendation changed, here is why" is only worth showing if the why is
// real. Each case below moves exactly ONE stored field between two versions and
// asserts that the differ names that field and the amount it moved by. The
// no-op case is the most important one: a resync that changed nothing must say
// so, because a manufactured difference is worse than silence.

const NAMES = { 101: 'Garner', 102: 'Saka', 103: 'Brooks', 104: 'Haaland', 105: 'Rice', 106: 'Isak' };

const gameState = {
  players: new Map(Object.entries(NAMES).map(([id, webName]) => [Number(id), {
    id: Number(id), webName, status: 'a', chanceNext: null, nowCost: 50, position: 3, teamId: 1,
  }])),
  teams: new Map([[1, { id: 1, name: 'Arsenal', shortName: 'ARS' }]]),
  rules: { positions: { 3: { id: 3, name: 'Midfielder', short: 'MID' } } },
};

function inputs(overrides = {}) {
  const players = {
    101: { p: 58, s: 'a', c: null, x: 4.2 },
    102: { p: 96, s: 'a', c: null, x: 4.8 },
    103: { p: 53, s: 'a', c: null, x: 3.7 },
    104: { p: 154, s: 'a', c: null, x: 5.2 },
    105: { p: 72, s: 'a', c: null, x: 4.1 },
    106: { p: 93, s: 'a', c: null, x: 4.4 },
    ...(overrides.players || {}),
  };
  return {
    bank: 7, ft: 1, chips: ['3xc', 'freehit'], horizon: 3, risk: 'balanced',
    ...overrides,
    players,
  };
}

function version({ plan, inputs: snap, reason = 'manual', computedAt = '2026-11-27T09:00:00Z' }) {
  return { version: 1, computedAt, reason, fingerprint: 'fp', plan, inputs: snap };
}

const ROLL = {
  gw: 13, chip: null, transfersOut: [], transfersIn: [], transferCount: 0, hits: 0, hitCostPoints: 0,
  captain: 104, viceCaptain: 105, formation: '3-4-3', xPointsGw: 54.3,
  headline: 'Roll your transfer',
};
const SELL_GARNER = {
  ...ROLL, transfersOut: [101], transfersIn: [102], transferCount: 1, headline: 'Make 1 transfer',
};

const diff = (prevInputs, nextInputs, { prevPlan = ROLL, nextPlan = SELL_GARNER, reason = 'manual' } = {}) =>
  diffPlanVersions(
    version({ plan: prevPlan, inputs: prevInputs }),
    version({ plan: nextPlan, inputs: nextInputs, reason }),
    { gameState },
  );

/* ------------------------------------------------------------ the contract */

test('the differ restates both recommendations, previous first', () => {
  const out = diff(inputs(), inputs({ players: { 101: { p: 58, s: 'i', c: 0, x: 0 } } }));
  assert.equal(out.changed, true);
  assert.equal(out.headline, 'Plan updated');
  assert.equal(out.previousLine, 'Roll your transfer');
  assert.equal(out.currentLine, 'Make 1 transfer: Garner out, Saka in');
});

test('a two-transfer recommendation is restated as pairs, so each sale names its buy', () => {
  const two = { ...ROLL, transfersOut: [101, 105], transfersIn: [102, 103], transferCount: 2, headline: 'Make 2 transfers' };
  const out = diff(inputs(), inputs(), { prevPlan: ROLL, nextPlan: two });
  assert.equal(out.currentLine, 'Make 2 transfers: Garner out, Saka in; Rice out, Brooks in');
});

test('a missing version on either side produces no diff at all, never a half one', () => {
  assert.equal(diffPlanVersions(null, version({ plan: ROLL, inputs: inputs() }), { gameState }), null);
  assert.equal(diffPlanVersions(version({ plan: ROLL, inputs: inputs() }), null, { gameState }), null);
  assert.equal(diffPlanVersions({ plan: null }, { plan: ROLL }, { gameState }), null);
});

/* ----------------------------------------------------- a player gets injured */

test('a player becoming injured is cited as the status field that moved', () => {
  const out = diff(inputs(), inputs({ players: { 101: { p: 58, s: 'i', c: 0, x: 0 } } }));
  assert.equal(out.changed, true);
  assert.ok(out.reasons.some(r => r.code === 'now_flagged' && r.text === 'Garner is now flagged injured.'), out.why);
  assert.match(out.why, /^Garner is now flagged injured\./);
});

test('a doubt, a return to fitness and a moving chance of playing are each their own sentence', () => {
  const doubt = diff(inputs(), inputs({ players: { 101: { p: 58, s: 'd', c: 0.5, x: 2.1 } } }));
  assert.ok(doubt.reasons.some(r => r.text === 'Garner now carries a fitness doubt.'), doubt.why);

  const back = diff(
    inputs({ players: { 101: { p: 58, s: 'i', c: 0, x: 0 } } }),
    inputs(),
  );
  assert.ok(back.reasons.some(r => r.text === 'Garner is available again.'), back.why);

  const chance = diff(
    inputs({ players: { 101: { p: 58, s: 'd', c: 0.75, x: 3.1 } } }),
    inputs({ players: { 101: { p: 58, s: 'd', c: 0.25, x: 1.2 } } }),
  );
  assert.ok(chance.reasons.some(r => r.text === "Garner's chance of playing moved from 75% to 25%."), chance.why);
});

test('an injury to a held player is reported even when the recommendation held', () => {
  const out = diff(
    inputs(),
    inputs({ players: { 106: { p: 93, s: 'i', c: 0, x: 0 } } }),
    { prevPlan: ROLL, nextPlan: ROLL },
  );
  assert.equal(out.changed, false);
  assert.equal(out.headline, 'Plan unchanged');
  assert.ok(out.reasons.some(r => r.text === 'Isak is now flagged injured.'), out.why);
});

/* ------------------------------------------------------- a projection moves */

test('a projection move is cited with its size and both endpoints', () => {
  const out = diff(inputs(), inputs({ players: { 102: { p: 96, s: 'a', c: null, x: 6.6 } } }));
  assert.ok(
    out.reasons.some(r => r.code === 'projection_moved' && r.text === "Saka's projection rose 1.8 points, from 4.8 to 6.6."),
    out.why,
  );
});

test('a projection move under the noise threshold is not reported as news', () => {
  const moved = (delta) => diff(inputs(), inputs({ players: { 102: { p: 96, s: 'a', c: null, x: 4.8 + delta } } }))
    .reasons.some(r => r.code === 'projection_moved');

  assert.equal(moved(DIFF_PARAMS.projectionMovePoints - 0.1), false);
  assert.equal(moved(DIFF_PARAMS.projectionMovePoints), true);
  assert.equal(moved(-(DIFF_PARAMS.projectionMovePoints - 0.1)), false);
  assert.equal(moved(-DIFF_PARAMS.projectionMovePoints), true);
});

test('projection moves are only reported for players either recommendation names', () => {
  // Rice is the vice-captain in both plans, so he counts. Isak is in neither.
  const out = diff(
    inputs(),
    inputs({ players: { 105: { p: 72, s: 'a', c: null, x: 6.9 }, 106: { p: 93, s: 'a', c: null, x: 9.9 } } }),
    { prevPlan: ROLL, nextPlan: ROLL },
  );
  const named = out.reasons.map(r => r.text).join(' ');
  assert.match(named, /Rice's projection rose/);
  assert.doesNotMatch(named, /Isak's projection/);
});

test('a projection that fell is reported as falling', () => {
  const out = diff(inputs(), inputs({ players: { 104: { p: 154, s: 'a', c: null, x: 3.0 } } }), { prevPlan: ROLL, nextPlan: ROLL });
  assert.ok(out.reasons.some(r => r.text === "Haaland's projection fell 2.2 points, from 5.2 to 3.0."), out.why);
});

/* ------------------------------------------- a price change moves the budget */

test('a price change is cited in money, with the direction and the new price', () => {
  const out = diff(inputs(), inputs({ players: { 102: { p: 97, s: 'a', c: null, x: 4.8 } } }));
  assert.ok(out.reasons.some(r => r.code === 'price_moved' && r.text === 'Saka rose £0.1m to £9.7m.'), out.why);

  const down = diff(inputs(), inputs({ players: { 101: { p: 56, s: 'a', c: null, x: 4.2 } } }));
  assert.ok(down.reasons.some(r => r.text === 'Garner fell £0.2m to £5.6m.'), down.why);
});

test('a price change that alters affordability shows the bank that moved with it', () => {
  const out = diff(
    inputs({ bank: 7 }),
    inputs({ bank: 2, players: { 102: { p: 101, s: 'a', c: null, x: 4.8 } } }),
  );
  const texts = out.reasons.map(r => r.text);
  assert.ok(texts.includes('Saka rose £0.5m to £10.1m.'), out.why);
  assert.ok(texts.includes('Your bank fell from £0.7m to £0.2m.'), out.why);
});

/* --------------------------------------------------- free transfers and chips */

test('a change in free transfers is cited with both counts and the direction', () => {
  const up = diff(inputs({ ft: 1 }), inputs({ ft: 2 }), { prevPlan: ROLL, nextPlan: ROLL });
  assert.ok(up.reasons.some(r => r.text === 'You have 2 free transfers now, up from 1.'), up.why);

  const down = diff(inputs({ ft: 2 }), inputs({ ft: 1 }), { prevPlan: ROLL, nextPlan: ROLL });
  assert.ok(down.reasons.some(r => r.text === 'You have 1 free transfer now, down from 2.'), down.why);
});

test('a chip leaving or returning to the pool is named by its game label', () => {
  const spent = diff(inputs({ chips: ['3xc', 'freehit'] }), inputs({ chips: ['3xc'] }), { prevPlan: ROLL, nextPlan: ROLL });
  assert.ok(spent.reasons.some(r => r.text === 'Your Free Hit is no longer available.'), spent.why);

  const back = diff(inputs({ chips: ['3xc'] }), inputs({ chips: ['3xc', 'wildcard'] }), { prevPlan: ROLL, nextPlan: ROLL });
  assert.ok(back.reasons.some(r => r.text === 'Your Wildcard is available again.'), back.why);
});

test('a settings change is a field that moved, not an unexplained rebuild', () => {
  const out = diff(inputs({ horizon: 3 }), inputs({ horizon: 5 }), { reason: 'settings-changed' });
  assert.equal(out.changed, true);
  assert.ok(out.reasons.some(r => r.text === 'You changed the horizon from 3 to 5 gameweeks.'), out.why);

  const risk = diff(inputs({ risk: 'balanced' }), inputs({ risk: 'aggressive' }), { reason: 'settings-changed' });
  assert.ok(risk.reasons.some(r => r.text === 'You changed the risk profile from balanced to aggressive.'), risk.why);
});

/* -------------------------------------------------------------- the no-op */

test('a resync that changed nothing says so, and invents no difference', () => {
  const out = diff(inputs(), inputs(), { prevPlan: ROLL, nextPlan: ROLL });
  assert.equal(out.changed, false);
  assert.equal(out.headline, 'Plan unchanged');
  assert.deepEqual(out.reasons, []);
  assert.equal(out.why, 'Nothing that feeds the plan has moved since it was last calculated.');
  assert.equal(out.previousLine, out.currentLine);
});

test('a changed recommendation with nothing stored to explain it cites the recalculation, not a guess', () => {
  const out = diffPlanVersions(
    version({ plan: ROLL, inputs: null }),
    version({ plan: SELL_GARNER, inputs: null, reason: 'squad-changed' }),
    { gameState },
  );
  assert.equal(out.changed, true);
  assert.deepEqual(out.reasons.map(r => r.code), ['recalculated']);
  assert.equal(out.why, 'Your squad changed.');
});

test('the reason list is capped so an explanation stays readable', () => {
  const out = diff(inputs(), inputs({
    bank: 0, ft: 2, chips: ['3xc'],
    players: {
      101: { p: 60, s: 'i', c: 0, x: 0 },
      102: { p: 99, s: 'd', c: 0.5, x: 2.0 },
      104: { p: 150, s: 'a', c: null, x: 1.0 },
      105: { p: 70, s: 'a', c: null, x: 9.0 },
    },
  }));
  assert.equal(out.reasons.length, DIFF_PARAMS.maxReasons);
  // Availability comes first, because a flag is a fact rather than a projection.
  assert.equal(out.reasons[0].code, 'now_flagged');
});

/* --------------------------------------------- what counts as a new answer */

test('the action key ignores what does not change the advice and catches what does', () => {
  const base = { chip: null, transfersOut: [101], transfersIn: [102], captain: 104, viceCaptain: 105, hits: 0 };
  assert.equal(actionKey(base), actionKey({ ...base, transfersOut: [101], transfersIn: [102] }));
  assert.equal(actionKey(base), actionKey({ ...base, formation: '4-4-2', xPointsGw: 99 }), 'a formation change is not a new answer');
  assert.notEqual(actionKey(base), actionKey({ ...base, captain: 105 }), 'a new captain is a new answer');
  assert.notEqual(actionKey(base), actionKey({ ...base, viceCaptain: 106 }));
  assert.notEqual(actionKey(base), actionKey({ ...base, chip: 'freehit' }));
  assert.notEqual(actionKey(base), actionKey({ ...base, hits: 1 }));
  assert.notEqual(actionKey(base), actionKey({ ...base, transfersIn: [103] }));
});

/* --------------------------------------------- the snapshot that makes it work */

test('the stored snapshot covers every player either plan could name, and nothing else', () => {
  const plan = { gw: 13, squad: [101, 102, 103], transfersOut: [104], transfersIn: [105] };
  const projections = {
    gwFrom: 13,
    byPlayer: new Map([101, 102, 103, 104, 105, 106].map(id => [id, [{ playerId: id, gw: 13, xPoints: id / 20 }]])),
  };
  const snapshot = planInputs({
    plan,
    projections,
    squadState: { bankTenths: 7, freeTransfers: 2, chipsAvailable: ['freehit', '3xc'] },
    gameState,
    dataStatus: { horizon: 3, risk: 'balanced' },
  });

  assert.deepEqual(Object.keys(snapshot.players).map(Number).sort((a, b) => a - b), [101, 102, 103, 104, 105]);
  assert.equal(snapshot.players[101].p, 50);
  assert.equal(snapshot.players[101].s, 'a');
  assert.equal(snapshot.players[105].x, 5.3, 'projections are rounded to the tenth the UI prints');
  assert.equal(snapshot.bank, 7);
  assert.equal(snapshot.ft, 2);
  assert.deepEqual(snapshot.chips, ['3xc', 'freehit'], 'sorted, so a reorder is not a change');
  assert.equal(snapshot.horizon, 3);
});

test('a snapshot survives the round trip through the plan history and still diffs', () => {
  const projections = { gwFrom: 13, byPlayer: new Map([[101, [{ playerId: 101, gw: 13, xPoints: 4.2 }]]]) };
  const squadState = { bankTenths: 7, freeTransfers: 1, chipsAvailable: ['freehit'] };
  const plan = { ...ROLL, squad: [101], explanation: { headline: 'Roll your transfer' } };

  let history = recordPlanVersion({}, 13, {
    plan,
    reason: 'first-calculation',
    fingerprint: 'a',
    inputs: planInputs({ plan, projections, squadState, gameState, dataStatus: { horizon: 3, risk: 'balanced' } }),
  });

  const injured = {
    players: new Map([[101, { ...gameState.players.get(101), status: 'i' }]]),
    teams: gameState.teams,
    rules: gameState.rules,
  };
  const later = { ...SELL_GARNER, squad: [102], explanation: { headline: 'Make 1 transfer' } };
  history = recordPlanVersion(history, 13, {
    plan: later,
    reason: 'players-changed',
    fingerprint: 'b',
    inputs: planInputs({
      plan: { ...later, squad: [101, 102] },
      projections: { gwFrom: 13, byPlayer: new Map([[101, [{ playerId: 101, gw: 13, xPoints: 0 }]], [102, [{ playerId: 102, gw: 13, xPoints: 4.8 }]]]) },
      squadState,
      gameState: injured,
      dataStatus: { horizon: 3, risk: 'balanced' },
    }),
  });

  const rehydrated = JSON.parse(JSON.stringify(history));
  const versions = rehydrated['13'];
  assert.equal(versions.length, 2);

  const out = diffPlanVersions(versions[0], versions[1], { gameState });
  assert.equal(out.changed, true);
  assert.equal(out.previousLine, 'Roll your transfer');
  assert.ok(out.reasons.some(r => r.text === 'Garner is now flagged injured.'), out.why);
  assert.ok(out.reasons.some(r => r.text === "Garner's projection fell 4.2 points, from 4.2 to 0.0."), out.why);
});

test('storing the snapshot does not lift the caps the synced document relies on', () => {
  const plan = { ...ROLL, squad: [101, 102, 103] };
  const snapshot = planInputs({
    plan,
    projections: { gwFrom: 13, byPlayer: new Map() },
    squadState: { bankTenths: 7, freeTransfers: 1, chipsAvailable: [] },
    gameState,
    dataStatus: { horizon: 3, risk: 'balanced' },
  });

  let history = {};
  for (let gw = 1; gw <= MAX_GWS_KEPT + 3; gw++) {
    for (let i = 0; i < MAX_VERSIONS_PER_GW + 2; i++) {
      history = recordPlanVersion(history, gw, { plan, reason: 'manual', fingerprint: `${gw}-${i}`, inputs: snapshot });
    }
  }
  assert.equal(Object.keys(history).length, MAX_GWS_KEPT);
  for (const list of Object.values(history)) assert.equal(list.length, MAX_VERSIONS_PER_GW);
  assert.ok(latestVersion(history, MAX_GWS_KEPT + 3).inputs, 'the snapshot rides along with the version');

  // The whole synced document, at its cap, with a realistic fifteen-player
  // snapshot per version, has to stay small enough to sync.
  const big = planInputs({
    plan: { ...ROLL, squad: [101, 102, 103, 104, 105, 106], transfersOut: [101], transfersIn: [102] },
    projections: { gwFrom: 13, byPlayer: new Map([101, 102, 103, 104, 105, 106].map(id => [id, [{ playerId: id, gw: 13, xPoints: 4.4 }]])) },
    squadState: { bankTenths: 7, freeTransfers: 1, chipsAvailable: ['3xc', 'freehit'] },
    gameState,
    dataStatus: { horizon: 3, risk: 'balanced' },
  });
  const perPlayer = JSON.stringify(big).length / Object.keys(big.players).length;
  const worstCase = perPlayer * 15 * MAX_VERSIONS_PER_GW * MAX_GWS_KEPT;
  assert.ok(worstCase < 120000, `plan history would grow to ~${Math.round(worstCase)} bytes`);
});

/* ------------------------------------------------- the compact plan is enough */

test('the compact plan a version stores carries everything the differ compares', () => {
  const compact = compactPlan({
    ...SELL_GARNER,
    squad: new Array(15).fill(0),
    explanation: { headline: 'Make 1 transfer', bullets: [] },
  });
  for (const field of ['chip', 'transfersOut', 'transfersIn', 'captain', 'viceCaptain', 'hits']) {
    assert.ok(field in compact, `${field} is compared by actionKey and must survive compactPlan`);
  }
  assert.equal(actionKey(compact), actionKey(SELL_GARNER));
});
