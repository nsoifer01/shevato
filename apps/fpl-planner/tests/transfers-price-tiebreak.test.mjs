// The price-change tie-break, driven through the REAL transfer search.
//
// tests/price-change.test.mjs pins the adjustment arithmetic in isolation. What
// that cannot show is whether the bound survives contact with searchTransfers:
// that `score` stays a pure football number, that a payload without the fields
// reaches byte-identical recommendations, and that a genuinely better transfer
// cannot be displaced by any price signal the API is capable of emitting.
//
// The sample payload predates the price-change fields, so every test here
// paints them on afterwards and compares against the same search with them
// absent. That comparison IS the regression guard for past seasons and for old
// fixtures.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assembleSampleBundle } from '../js/data/sample.js';
import { buildGameState, normalizePriceChange } from '../js/engine/normalize.js';
import { buildSquadState } from '../js/engine/squad.js';
import { buildPlan } from '../js/engine/planner.js';
import { searchTransfers, priceUrgencyCap, TRANSFER_DEFAULTS } from '../js/engine/transfers.js';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const sample = (name) => JSON.parse(readFileSync(join(APP, 'data', 'sample', `${name}.json`), 'utf8'));
const names = ['meta', 'bootstrap', 'fixtures', 'entry', 'entry-history', 'entry-transfers', 'entry-picks'];
const files = assembleSampleBundle(Object.fromEntries(names.map(n => [n, sample(n)])));

const sampleState = buildGameState(files.bootstrap, files.fixtures, { fetchedAt: files.fetchedAt });
const gw = files.planEvent;

// The sample dataset SHIPS price-change data (so ?demo=1 demonstrates the
// feature), so "no price data" has to be constructed rather than assumed. Every
// test below starts from this stripped world and paints on exactly the signals
// it is about, which keeps each test's price landscape explicit instead of
// inheriting whatever the demo happens to carry.
function stripPrices(state) {
  const players = new Map();
  for (const [id, p] of state.players) players.set(id, { ...p, priceChange: null });
  return { ...state, players, rules: { ...state.rules, priceChangeDeadlines: [] } };
}
const baseState = stripPrices(sampleState);
const squadState = buildSquadState({
  entry: files.entry, history: files.history, transfers: files.transfers,
  picks: files.picks, gameState: baseState, gw,
});
// The projections the planner itself builds, so the search below is scoring the
// same numbers the app does (buildProjections needs the fitted strength model,
// which buildPlan owns).
const projections = (await buildPlan({
  gameState: baseState, squadState, options: { horizon: 3, seed: 7 },
})).projections;

const DEADLINES = ['2026-09-05T23:00:00Z', '2026-09-06T23:00:00Z', '2026-09-07T23:00:00Z']
  .map(d => new Date(d).toISOString());
const NOW = Date.parse('2026-09-05T21:30:00Z');
const CAP = priceUrgencyCap(TRANSFER_DEFAULTS);

const RISE_TONIGHT = {
  price_change_percent: '96.0',
  price_change_projections: [{ offset: 0, projected_percent: '120.0', likelihood: 5 }],
};
const FALL_TONIGHT = {
  price_change_percent: '-96.0',
  price_change_projections: [{ offset: 0, projected_percent: '-120.0', likelihood: -5 }],
};

function stateWith(overrides = {}) {
  const players = new Map();
  for (const [id, p] of baseState.players) players.set(id, { ...p });
  for (const [id, raw] of Object.entries(overrides)) {
    players.get(Number(id)).priceChange = raw === null ? null : normalizePriceChange(raw);
  }
  return { ...baseState, players, rules: { ...baseState.rules, priceChangeDeadlines: DEADLINES } };
}

const search = (gameState) => searchTransfers({
  squadState, projections, gameState, rules: gameState.rules,
  horizon: 3, opts: { now: NOW, maxTransfers: 1, maxCandidates: 12 },
});

// The search with no price data anywhere: the behaviour that shipped before
// this feature, and the thing every assertion below is measured against.
const plansWithout = search(baseState);
const keyOf = (p) => `${(p.transfersOut || []).join('+')}>${(p.transfersIn || []).join('+')}`;

test('the sample search produces enough candidates for these tests to mean anything', () => {
  assert.ok(plansWithout.length >= 3, `only ${plansWithout.length} candidates`);
  assert.ok(plansWithout.some(p => p.transferCount > 0), 'at least one real transfer');
});

test('a payload with no price fields reproduces the previous recommendation exactly', () => {
  // SPEC: the whole feature must be a no-op without the data. Same order, same
  // scores, same plan at rank 1.
  const again = search(stateWith({}));
  assert.deepEqual(again.map(keyOf), plansWithout.map(keyOf), 'identical ordering');
  for (let i = 0; i < again.length; i++) {
    assert.equal(again[i].score, plansWithout[i].score, 'identical scores');
    assert.equal(again[i].priceAdjustment, 0, 'no adjustment without data');
    assert.equal(again[i].sortScore, again[i].score, 'the sort key collapses onto the score');
  }
});

test('price data never changes the points a plan is reported to score', () => {
  // SPEC: `score` is what the app shows and explains. The tie-break lives in
  // `sortScore` precisely so this stays true.
  const winner = plansWithout.find(p => p.transferCount === 1);
  const state = stateWith({ [winner.transfersIn[0]]: RISE_TONIGHT, [winner.transfersOut[0]]: FALL_TONIGHT });
  const withPrice = search(state);

  const byKey = new Map(plansWithout.map(p => [keyOf(p), p]));
  for (const p of withPrice) {
    const before = byKey.get(keyOf(p));
    if (!before) continue;
    assert.equal(p.score, before.score, `${keyOf(p)}: score must be football only`);
    assert.equal(p.xPointsHorizon, before.xPointsHorizon);
  }
});

test('the adjustment applied by the real search never exceeds the cap', () => {
  // Every owned player about to fall and every buyable player about to rise:
  // the most one-sided payload the API could produce.
  const overrides = {};
  for (const pick of squadState.picks) overrides[pick.playerId] = FALL_TONIGHT;
  for (const [id, p] of baseState.players) {
    if (!overrides[id] && p.status === 'a') overrides[id] = RISE_TONIGHT;
  }
  for (const p of search(stateWith(overrides))) {
    assert.ok(Math.abs(p.priceAdjustment) <= CAP + 1e-12, `${keyOf(p)} adjusted by ${p.priceAdjustment}`);
    assert.ok(Math.abs(p.sortScore - p.score) <= CAP + 1e-12);
  }
});

test('a clearly better transfer cannot be displaced by any price signal', () => {
  // SPEC: take the winner and the best plan that is more than 2*CAP behind it,
  // then push every price signal in favour of the loser. The winner must hold,
  // because the bound makes the outcome arithmetic rather than a matter of
  // tuning.
  const winner = plansWithout[0];
  const clearLoser = plansWithout.find(p => winner.score - p.score > 2 * CAP && p.transferCount === 1);
  assert.ok(clearLoser, 'the sample search must contain a clearly worse one-transfer plan');

  const overrides = {
    [clearLoser.transfersIn[0]]: RISE_TONIGHT,   // buying it is urgent
    [clearLoser.transfersOut[0]]: FALL_TONIGHT,  // selling it is urgent
  };
  // And make the winner's move look as unattractive as the API can.
  if (!overrides[winner.transfersIn?.[0]]) overrides[winner.transfersIn?.[0]] = FALL_TONIGHT;
  if (!overrides[winner.transfersOut?.[0]]) overrides[winner.transfersOut?.[0]] = RISE_TONIGHT;
  delete overrides[undefined];

  const withPrice = search(stateWith(overrides));
  assert.equal(keyOf(withPrice[0]), keyOf(winner), 'the better plan on points still wins');
});

test('price urgency does break a near-tie, which is the point of shipping it', () => {
  // SPEC: the complement of the test above. Without a case where the signal
  // actually decides something, the feature would be inert and the cap
  // untested at the only boundary that matters.
  const pairs = [];
  for (let i = 0; i < plansWithout.length; i++) {
    for (let j = i + 1; j < plansWithout.length; j++) {
      const gap = plansWithout[i].score - plansWithout[j].score;
      if (gap > 0 && gap < CAP && plansWithout[j].transferCount === 1) {
        pairs.push([plansWithout[i], plansWithout[j]]);
      }
    }
  }
  assert.ok(pairs.length, 'the sample search must contain a pair inside the cap');

  const [ahead, behind] = pairs[0];
  // ONLY the incoming player is painted, and that is the whole subtlety of this
  // test. In this squad every one-transfer candidate sells the SAME player, so
  // marking the outgoing side gives every candidate the identical bonus and the
  // ordering cannot move. A signal only decides anything when it applies to
  // something the candidates do not share.
  assert.equal(behind.transfersOut[0], ahead.transfersOut[0], 'these two differ only in who comes in');
  const withPrice = search(stateWith({ [behind.transfersIn[0]]: RISE_TONIGHT }));

  const order = withPrice.map(keyOf);
  assert.ok(
    order.indexOf(keyOf(behind)) < order.indexOf(keyOf(ahead)),
    'a plan behind by less than the cap is promoted when the money favours it',
  );
  const promoted = withPrice.find(p => keyOf(p) === keyOf(behind));
  assert.equal(promoted.score, behind.score, 'and it is promoted without its reported points changing');
});

test('a signal shared by a group of candidates cannot reorder that group', () => {
  // SPEC: the flip side of the test above. Marking one outgoing player a faller
  // adds the SAME constant to every candidate that sells him, so their relative
  // order must be untouched: a tie-break can only separate plans it treats
  // differently. (It may still move that whole group against candidates selling
  // someone else, which is correct and is why this asserts within the group.)
  const shared = plansWithout.find(p => p.transferCount === 1).transfersOut[0];
  const sellsShared = (p) => p.transferCount === 1 && p.transfersOut[0] === shared;

  const withPrice = search(stateWith({ [shared]: FALL_TONIGHT }));
  const before = plansWithout.filter(sellsShared).map(keyOf);
  const after = withPrice.filter(sellsShared).map(keyOf);

  // Compare on the candidates both searches actually returned: the shortlist is
  // chosen on the sort key, so the tail of a 12-deep list legitimately differs.
  const common = new Set(after);
  assert.deepEqual(before.filter(k => common.has(k)), after.filter(k => new Set(before).has(k)));
  assert.ok(before.length >= 5, 'a group worth asserting on');

  for (const p of withPrice.filter(sellsShared)) {
    assert.equal(p.priceAdjustment, withPrice.filter(sellsShared)[0].priceAdjustment,
      'every candidate selling the faller gets the identical adjustment');
  }
});

test('the price signal can never talk the engine into making a transfer', () => {
  // SPEC: the roll is always adjusted by exactly zero, so holding is compared
  // to transferring on football alone.
  const overrides = {};
  for (const [id, p] of baseState.players) {
    if (p.status === 'a') overrides[id] = RISE_TONIGHT;
  }
  const roll = search(stateWith(overrides)).find(p => p.transferCount === 0);
  assert.ok(roll, 'the roll is always a candidate');
  assert.equal(roll.priceAdjustment, 0);
  assert.equal(roll.sortScore, roll.score);
});

test('a locked player carries a badge but moves no decision', () => {
  const winner = plansWithout.find(p => p.transferCount === 1);
  const locked = { ...RISE_TONIGHT, price_change_locked_until: '2026-09-12T14:30:00Z' };
  const withPrice = search(stateWith({ [winner.transfersIn[0]]: locked }));
  assert.deepEqual(withPrice.map(keyOf), plansWithout.map(keyOf), 'ordering untouched by a locked player');
  for (const p of withPrice) assert.equal(p.priceAdjustment, 0);
});

test('a calibrating prediction moves no decision either', () => {
  const winner = plansWithout.find(p => p.transferCount === 1);
  const calib = { ...RISE_TONIGHT, price_change_calibrating: true };
  const withPrice = search(stateWith({ [winner.transfersIn[0]]: calib }));
  assert.deepEqual(withPrice.map(keyOf), plansWithout.map(keyOf));
  for (const p of withPrice) assert.equal(p.priceAdjustment, 0);
});
