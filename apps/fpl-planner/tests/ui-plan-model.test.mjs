import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGameState } from '../js/engine/normalize.js';
import {
  getProjection, formationRows, pitchRows, actionText, pairUp, chipDecision,
  describePlayer, fixtureLabel, availability, assessData, inputFingerprint,
  outdatedReason, AVAILABILITY_MAX_AGE_SECONDS,
} from '../js/ui/plan-model.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => JSON.parse(readFileSync(join(here, ...p), 'utf8'));

const bootstrap = read('fixtures', 'bootstrap.json');
const fixtures = read('fixtures', 'fixtures.json');
const eventsInSeason = read('fixtures', 'events-in-season.json');
const gameState = buildGameState({ ...bootstrap, events: eventsInSeason }, fixtures, { fetchedAt: '2026-09-24T10:00:00Z' });

const anyPlayer = [...gameState.players.values()][0];

/* ------------------------------------------------------------ projections */

test('projections are read from byPlayer, because a worker drops the get() method', () => {
  const projections = {
    gwFrom: 6,
    gwTo: 10,
    byPlayer: new Map([[7, [{ xPoints: 1 }, { xPoints: 2 }, { xPoints: 3 }]]]),
  };
  assert.equal(getProjection(projections, 7, 6).xPoints, 1);
  assert.equal(getProjection(projections, 7, 8).xPoints, 3);
  assert.equal(getProjection(projections, 7, 99), null);
  assert.equal(getProjection(projections, 999, 6), null);
  assert.equal(getProjection(null, 7, 6), null);
});

test('a plain object byPlayer works too, in case structured clone hands back an object', () => {
  const projections = { gwFrom: 1, byPlayer: { 5: [{ xPoints: 4 }] } };
  assert.equal(getProjection(projections, 5, 1).xPoints, 4);
});

/* --------------------------------------------------------------- formation */

test('formation rows put the implicit goalkeeper row back', () => {
  assert.deepEqual(formationRows('3-4-3'), [1, 3, 4, 3]);
  assert.deepEqual(formationRows('5-4-1'), [1, 5, 4, 1]);
  assert.equal(formationRows('nonsense'), null);
  assert.equal(formationRows(''), null);
});

test('a formation the game invents later still renders', () => {
  assert.deepEqual(formationRows('2-5-2-1'), [1, 2, 5, 2, 1]);
});

test('players are bucketed by real position, whatever order the XI arrives in', () => {
  // Deliberately shuffled: a forward first, the keeper last.
  const xi = [401, 201, 202, 203, 301, 302, 303, 304, 402, 403, 101];
  const positionOf = (id) => Math.floor(id / 100);
  const rows = pitchRows(xi, '3-4-3', positionOf);
  assert.deepEqual(rows, [[101], [201, 202, 203], [301, 302, 303, 304], [401, 402, 403]]);
});

/* ------------------------------------------------------------- the action */

const rollPlan = {
  gw: 13,
  transferCount: 0,
  freeTransfersAfter: 2,
  // 2 banked and none spent means gameweek 14 starts with 3, not 2. The
  // sentence reports what next week STARTS with, so it reads the field the
  // engine computed for that and never adds one itself.
  freeTransfersNextGw: 3,
  transfersIn: [],
  transfersOut: [],
  chip: null,
  explanation: { headline: 'Roll your transfer' },
};

test('rolling reads as a decision, not as an absence of one', () => {
  const { headline, sub } = actionText(rollPlan, () => 'X');
  assert.equal(headline, 'Roll your transfer');
  assert.match(sub, /Bank this week's transfer/);
  assert.match(sub, /3 free transfers/);
});

test('transfers are named in the supporting line, out first', () => {
  const plan = {
    gw: 13,
    transferCount: 2,
    transfersOut: [1, 2],
    transfersIn: [3, 4],
    hits: 0,
    chip: null,
    explanation: {
      headline: 'Make 2 transfers',
      transferReasons: [
        { out: 1, in: 3, gwGain: 1.5, horizonGain: 4.5, reasons: [] },
        { out: 2, in: 4, gwGain: 0.5, horizonGain: 1.5, reasons: [] },
      ],
    },
  };
  const names = { 1: 'Garner', 2: "O'Nien", 3: 'Brooks', 4: 'Bijol' };
  const { headline, sub } = actionText(plan, id => names[id]);
  assert.equal(headline, 'Make 2 transfers');
  assert.equal(sub, "Garner out, Brooks in; O'Nien out, Bijol in.");
});

test('a hit is stated in the action line, in points', () => {
  const plan = {
    gw: 13, transferCount: 2, transfersOut: [1, 2], transfersIn: [3, 4],
    hits: 1, hitCostPoints: 4, chip: null,
    explanation: { headline: 'Make 2 transfers and take a 4 point hit' },
  };
  const { sub } = actionText(plan, id => `P${id}`);
  assert.match(sub, /Taking 1 hit, 4 points\./);
});

test('a free hit says the squad comes back, a wildcard counts the changes', () => {
  const freehit = actionText({ gw: 20, chip: 'freehit', transferCount: 9, explanation: { headline: 'Play your Free Hit' } }, () => 'X');
  assert.match(freehit.sub, /Your real squad comes back next week/);
  const wildcard = actionText({ gw: 20, chip: 'wildcard', transferCount: 6, explanation: { headline: 'Play your Wildcard' } }, () => 'X');
  assert.match(wildcard.sub, /6 changes/);
});

test('a pre-season draft describes the fifteen, not a transfer count of zero', () => {
  const draft = {
    gw: 1, transferCount: 0, transfersIn: [], transfersOut: [], chip: null,
    squad: new Array(15).fill(0).map((_, i) => i + 1),
    horizon: 5,
    explanation: { headline: 'Build this opening 15' },
  };
  const { headline, sub } = actionText(draft, () => 'X', { isDraft: true });
  assert.equal(headline, 'Build this opening 15');
  assert.match(sub, /squad of 15 for Gameweek 1/);
  assert.doesNotMatch(sub, /transfer/);
});

test('without an engine headline the fallback still states an action', () => {
  assert.equal(actionText({ gw: 5, transferCount: 0, freeTransfersAfter: 1, transfersIn: [], transfersOut: [] }, () => 'X').headline, 'Roll your transfer');
  assert.equal(actionText({ gw: 5, transferCount: 1, transfersOut: [1], transfersIn: [2], hits: 0 }, () => 'X').headline, 'Make 1 transfer');
  assert.equal(actionText({ gw: 5, chip: '3xc', transferCount: 0 }, () => 'X').headline, 'Play your Triple Captain');
});

test('pairing prefers the engine pairing and falls back to index order', () => {
  const withReasons = pairUp({
    transferCount: 1, transfersOut: [9], transfersIn: [8],
    explanation: { transferReasons: [{ out: 9, in: 8, gwGain: 2, horizonGain: 6, reasons: [{ text: 'x' }] }] },
  });
  assert.deepEqual(withReasons.map(p => [p.out, p.in, p.gwGain]), [[9, 8, 2]]);

  const bare = pairUp({ transferCount: 2, transfersOut: [1, 2], transfersIn: [3, 4] });
  assert.deepEqual(bare.map(p => [p.out, p.in]), [[1, 3], [2, 4]]);
});

test('no chip is a decision with the engine reason attached', () => {
  const reason = { decision: 'hold', chip: null, reasons: [{ text: 'nothing clears its bar' }] };
  const held = chipDecision({ chip: null, explanation: { chipReason: reason } });
  assert.equal(held.playing, false);
  assert.equal(held.label, 'No chip');
  assert.equal(held.reason, reason);

  const played = chipDecision({ chip: 'bboost', explanation: { chipReason: { decision: 'play' } } });
  assert.equal(played.playing, true);
  assert.equal(played.label, 'Bench Boost');
});

/* ------------------------------------------------------------ player cards */

test('describePlayer resolves club, position and price from the game state', () => {
  const info = describePlayer(gameState, anyPlayer.id);
  assert.equal(info.name, anyPlayer.webName);
  assert.equal(info.priceTenths, anyPlayer.nowCost);
  assert.equal(info.positionShort, gameState.rules.positions[anyPlayer.position].short);
  assert.ok(info.club.length > 0);
});

test('an unknown player id degrades to a label instead of throwing', () => {
  const info = describePlayer(gameState, 999999);
  assert.equal(info.name, 'Player 999999');
  assert.equal(info.priceTenths, 0);
});

test('fixture labels mark home and away, doubles and blanks', () => {
  const home = [...gameState.teams.values()][0];
  const away = [...gameState.teams.values()][1];
  assert.equal(fixtureLabel({ fixtures: [{ opponentId: away.id, isHome: true }] }, gameState), `${away.shortName} (H)`);
  assert.equal(
    fixtureLabel({ fixtures: [{ opponentId: away.id, isHome: true }, { opponentId: home.id, isHome: false }] }, gameState),
    `${away.shortName} (H), ${home.shortName} (A)`,
  );
  assert.equal(fixtureLabel({ fixtures: [] }, gameState), 'No fixture');
  assert.equal(fixtureLabel(null, gameState), 'No fixture');
});

test('availability separates a hard out from a doubt, and carries the percentage', () => {
  assert.equal(availability({ status: 'a' }), null);
  assert.deepEqual(availability({ status: 'i', news: 'Knee' }), { kind: 'out', label: 'Injured', news: 'Knee' });
  assert.equal(availability({ status: 's' }).label, 'Suspended');
  assert.equal(availability({ status: 'd', chanceNext: 0.75 }).label, '75% fit');
  assert.equal(availability({ status: 'd', chanceNext: null }).label, 'Doubt');
});

/* -------------------------------------------------------------- freshness */

test('a healthy fetch set is presented as it is', () => {
  const assessment = assessData({
    sources: [
      { name: 'Players, prices and news', path: 'bootstrap-static', ok: true, stale: false, ageSeconds: 30 },
      { name: 'Fixtures', path: 'fixtures', ok: true, stale: false, ageSeconds: 30 },
    ],
  });
  assert.equal(assessment.ok, true);
  assert.equal(assessment.withholdPlan, false);
  assert.equal(assessment.reason, null);
});

test('a plan is withheld when availability is too old to trust', () => {
  const assessment = assessData({
    sources: [
      { name: 'Players, prices and news', path: 'bootstrap-static', ok: true, stale: true, ageSeconds: AVAILABILITY_MAX_AGE_SECONDS + 60 },
    ],
  });
  assert.equal(assessment.availabilityUnknown, true);
  assert.equal(assessment.withholdPlan, true);
  assert.match(assessment.reason, /injuries and suspensions may be out of date/);
});

test('a slightly stale bootstrap is reported but does not withhold the plan', () => {
  const assessment = assessData({
    sources: [
      { name: 'Players, prices and news', path: 'bootstrap-static', ok: true, stale: true, ageSeconds: 600 },
    ],
  });
  assert.deepEqual(assessment.stale, ['Players, prices and news']);
  assert.equal(assessment.withholdPlan, false);
});

/* ------------------------------------------------------------ fingerprint */

const squadA = {
  gw: 13,
  bankTenths: 7,
  freeTransfers: 2,
  chipsAvailable: ['freehit', '3xc'],
  picks: [...gameState.players.keys()].slice(0, 15).map(playerId => ({ playerId })),
};

test('the fingerprint covers gameweek, money, transfers, chips and every held player', () => {
  const fp = inputFingerprint(squadA, gameState);
  assert.match(fp, /^gw:13\|bank:7\|ft:2\|chips:3xc,freehit\|/);
  for (const pick of squadA.picks) assert.ok(fp.includes(`|${pick.playerId}:`), `player ${pick.playerId} is in the fingerprint`);
});

test('the fingerprint is order independent, so a reordered squad is not a change', () => {
  const reordered = { ...squadA, picks: squadA.picks.slice().reverse() };
  assert.equal(inputFingerprint(squadA, gameState), inputFingerprint(reordered, gameState));
});

test('a price or status change moves the fingerprint', () => {
  const before = inputFingerprint(squadA, gameState);
  const id = squadA.picks[0].playerId;
  const player = gameState.players.get(id);
  const original = player.nowCost;
  player.nowCost = original + 1;
  const after = inputFingerprint(squadA, gameState);
  player.nowCost = original;
  assert.notEqual(before, after);
});

test('outdated reasons never blame the manager', () => {
  assert.equal(outdatedReason('same', 'same'), null);
  assert.equal(outdatedReason('', 'x'), null);

  const newGw = outdatedReason('gw:13|bank:7|ft:1|chips:|1:50:a', 'gw:14|bank:7|ft:1|chips:|1:50:a');
  assert.equal(newGw.code, 'new-gameweek');

  const squadChanged = outdatedReason('gw:13|bank:7|ft:1|chips:|1:50:a', 'gw:13|bank:7|ft:1|chips:|2:50:a');
  assert.equal(squadChanged.code, 'squad-changed');
  assert.equal(squadChanged.text, "Team updated. We've rebuilt your plan based on your current squad.");
  assert.doesNotMatch(squadChanged.text, /you (did|should|ignored)/i);

  const budget = outdatedReason('gw:13|bank:7|ft:1|chips:|1:50:a', 'gw:13|bank:2|ft:1|chips:|1:50:a');
  assert.equal(budget.code, 'budget-changed');

  const price = outdatedReason('gw:13|bank:7|ft:1|chips:|1:50:a', 'gw:13|bank:7|ft:1|chips:|1:51:a');
  assert.equal(price.code, 'players-changed');
});
