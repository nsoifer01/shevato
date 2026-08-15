// Transfers already made for the gameweek being planned.
//
// `entry/{id}/event/{gw}/picks` is frozen at that gameweek's deadline. Between
// gameweeks a manager transfers for the NEXT one, and until that one is played
// those moves exist only on `entry/{id}/transfers`. Reading the picks alone
// describes a squad he no longer owns, which is the most common interaction
// there is: transfer on the FPL site, then open the planner.
//
// Every money and free-transfer assertion here is computed by hand from the
// fixture rather than read back out of the module, because the failure this
// guards against is precisely a plausible number that came from the wrong
// squad.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assembleSampleBundle } from '../js/data/sample.js';
import { buildGameState } from '../js/engine/normalize.js';
import { buildSquadState, pendingTransfers } from '../js/engine/squad.js';
import { buildPlan } from '../js/engine/planner.js';
import { inputFingerprint, outdatedReason } from '../js/ui/plan-model.js';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const sample = (n) => JSON.parse(readFileSync(join(APP, 'data', 'sample', `${n}.json`), 'utf8'));
const NAMES = ['meta', 'bootstrap', 'fixtures', 'entry', 'entry-history', 'entry-transfers', 'entry-picks'];
const B = assembleSampleBundle(Object.fromEntries(NAMES.map(n => [n, sample(n)])));
const clone = (v) => JSON.parse(JSON.stringify(v));

const gameState = buildGameState(clone(B.bootstrap), clone(B.fixtures), { fetchedAt: new Date().toISOString() });
const rules = gameState.rules;
const PLAN_GW = B.planEvent;
const P = (id) => gameState.players.get(id);

// The squad as FPL froze it, with no transfer made yet.
const frozen = () => buildSquadState({
  entry: clone(B.entry), history: clone(B.history), transfers: clone(B.transfers),
  picks: clone(B.picks), gameState, gw: PLAN_GW,
});

// A transfer row for the gameweek being planned. The selling price comes from
// the squad AS IT STANDS when the transfer is made, which for the second and
// later moves in a window is not the frozen fifteen.
function row(outId, inId, { event = PLAN_GW, time = '2026-01-01T10:00:00Z', squad = null } = {}) {
  const from = squad || frozen();
  const held = from.picks.find(p => p.playerId === outId);
  return {
    element_out: outId,
    element_out_cost: held ? held.sellingTenths : P(outId).nowCost,
    element_in: inId,
    element_in_cost: P(inId).nowCost,
    entry: B.entry.id,
    event,
    time,
  };
}

// A same-position replacement not already owned and affordable from the bank
// plus the sale.
function replacementFor(squad, outId, extraFunds = 0) {
  const owned = new Set(squad.picks.map(p => p.playerId));
  const out = P(outId);
  const funds = squad.bankTenths + squad.picks.find(p => p.playerId === outId).sellingTenths + extraFunds;
  const clubCount = (teamId) => squad.picks.filter(p => p.playerId !== outId && P(p.playerId).teamId === teamId).length;
  for (const p of gameState.players.values()) {
    if (p.position !== out.position || owned.has(p.id)) continue;
    if (p.nowCost > funds) continue;
    if (clubCount(p.teamId) >= rules.clubLimit) continue;
    return p.id;
  }
  return null;
}

const withTransfers = (rows) => buildSquadState({
  entry: clone(B.entry), history: clone(B.history),
  transfers: clone(B.transfers).concat(rows),
  picks: clone(B.picks), gameState, gw: PLAN_GW,
});

/* --------------------------------------------------------------- the basics */

test('the sample fixture has a frozen squad and free transfers to spend', () => {
  const s = frozen();
  assert.equal(s.picks.length, rules.squadSize);
  assert.ok(Number.isFinite(s.freeTransfers) && s.freeTransfers >= 1, `free transfers ${s.freeTransfers}`);
  assert.deepEqual(s.pendingTransfers, [], 'nothing pending before a transfer is made');
});

test('one transfer made for the planned gameweek is reflected in the squad', () => {
  const base = frozen();
  const outId = base.picks[4].playerId;
  const inId = replacementFor(base, outId);
  assert.ok(inId, 'the fixture must offer a legal replacement');

  const s = withTransfers([row(outId, inId)]);
  assert.equal(s.picks.some(p => p.playerId === outId), false, 'the sold player is gone');
  assert.equal(s.picks.some(p => p.playerId === inId), true, 'the bought player is here');
  assert.equal(s.picks.length, rules.squadSize, 'and it is still fifteen');
  assert.equal(s.pendingTransfers.length, 1);
});

test('the bank moves by exactly what the transfer row says', () => {
  const base = frozen();
  const outId = base.picks[6].playerId;
  const inId = replacementFor(base, outId);
  const r = row(outId, inId);

  const s = withTransfers([r]);
  // Computed here, from the row, not from the module.
  const expected = base.bankTenths + r.element_out_cost - r.element_in_cost;
  assert.equal(s.bankTenths, expected,
    `bank ${base.bankTenths} + ${r.element_out_cost} - ${r.element_in_cost}`);
});

test('the incoming player keeps the price he was actually bought at', () => {
  const base = frozen();
  const outId = base.picks[2].playerId;
  const inId = replacementFor(base, outId);
  const r = row(outId, inId);
  const s = withTransfers([r]);
  const bought = s.picks.find(p => p.playerId === inId);
  assert.equal(bought.purchaseTenths, r.element_in_cost);
  // Bought at the current price means no profit yet, so he sells for what he cost.
  assert.equal(bought.sellingTenths, r.element_in_cost);
});

/* ------------------------------------------------- free transfers and hits */

test('a transfer already made spends a free transfer', () => {
  const base = frozen();
  const before = base.freeTransfers;
  const outId = base.picks[3].playerId;
  const inId = replacementFor(base, outId);
  const s = withTransfers([row(outId, inId)]);
  assert.equal(s.freeTransfers, before - 1, `free transfers ${before} -> ${s.freeTransfers}`);
  assert.equal(s.hitsAlreadyTaken, 0);
});

test('using the last free transfer leaves none, and the next one costs a hit', async () => {
  const base = frozen();
  const free = base.freeTransfers;
  const rows = [];
  let squad = base;
  for (let i = 0; i < free; i++) {
    const outId = squad.picks.find(p => !rows.some(r => r.element_out === p.playerId)).playerId;
    const inId = replacementFor(squad, outId);
    if (!inId) break;
    rows.push(row(outId, inId, { time: `2026-01-0${i + 1}T10:00:00Z`, squad }));
    squad = withTransfers(rows);
  }
  assert.equal(rows.length, free, 'the fixture must allow the free transfers to be used');
  assert.equal(squad.freeTransfers, 0, 'every free transfer is spent');
  assert.equal(squad.hitsAlreadyTaken, 0, 'and no hit was taken to do it');

  // The planner, starting from here, must price its next move as a hit.
  const bundle = await buildPlan({ gameState, squadState: squad, options: { horizon: 2 } });
  if (bundle.current.transferCount > 0) {
    assert.equal(bundle.current.hits, bundle.current.transferCount,
      'with no free transfers left every further transfer is a hit');
    assert.equal(bundle.current.hitCostPoints, bundle.current.hits * rules.hitCost);
  }
});

test('transfers beyond the free ones report the hit already taken', () => {
  const base = frozen();
  const free = base.freeTransfers;
  const rows = [];
  let squad = base;
  for (let i = 0; i < free + 1; i++) {
    const outId = squad.picks.find(p => !rows.some(r => r.element_out === p.playerId)).playerId;
    const inId = replacementFor(squad, outId);
    if (!inId) break;
    rows.push(row(outId, inId, { time: `2026-01-0${i + 1}T10:00:00Z`, squad }));
    squad = withTransfers(rows);
  }
  assert.equal(rows.length, free + 1);
  assert.equal(squad.freeTransfers, 0);
  assert.equal(squad.hitsAlreadyTaken, 1, 'one transfer past the free ones is one hit');
});

/* ------------------------------------------------------------------ chains */

test('a chain inside one window collapses to its net effect', () => {
  const base = frozen();
  const outId = base.picks[5].playerId;
  const midId = replacementFor(base, outId);
  const afterFirst = withTransfers([row(outId, midId)]);
  const finalId = replacementFor(afterFirst, midId);
  assert.ok(finalId && finalId !== outId, 'the fixture must offer a second replacement');

  const s = withTransfers([
    row(outId, midId, { time: '2026-01-01T10:00:00Z' }),
    { ...row(outId, midId, { time: '2026-01-01T11:00:00Z' }),
      element_out: midId,
      element_out_cost: P(midId).nowCost,
      element_in: finalId,
      element_in_cost: P(finalId).nowCost },
  ]);

  assert.equal(s.picks.some(p => p.playerId === outId), false, 'the original player left');
  assert.equal(s.picks.some(p => p.playerId === midId), false, 'the intermediate player did not stay');
  assert.equal(s.picks.some(p => p.playerId === finalId), true, 'the final player is held');
  assert.equal(s.picks.length, rules.squadSize);
});

/* ------------------------------------------------- transfers in other weeks */

test('transfers belonging to earlier gameweeks are already in the picks and are not applied twice', () => {
  const base = frozen();
  const outId = base.picks[1].playerId;
  const inId = replacementFor(base, outId);
  // A transfer from a PREVIOUS gameweek: the frozen picks already reflect it.
  const s = withTransfers([row(outId, inId, { event: PLAN_GW - 1 })]);
  assert.equal(s.picks.some(p => p.playerId === outId), true,
    'a previous gameweek transfer must not be replayed onto the frozen squad');
  assert.deepEqual(s.pendingTransfers, []);
  assert.equal(s.bankTenths, base.bankTenths);
});

/* ------------------------------------------- the planner sees the real squad */

test('the planner never recommends a transfer the manager has already made', async () => {
  const base = frozen();
  const outId = base.picks[7].playerId;
  const inId = replacementFor(base, outId);
  const s = withTransfers([row(outId, inId)]);

  const bundle = await buildPlan({ gameState, squadState: s, options: { horizon: 3 } });
  assert.equal(bundle.current.transfersIn.includes(inId), false,
    'it cannot buy a player the manager already owns');
  assert.equal(bundle.current.transfersOut.includes(outId), false,
    'and it cannot sell a player the manager no longer has');
  assert.equal(bundle.current.squad.includes(inId), true, 'the plan is built on the real squad');
  assert.equal(bundle.validation.ok, true);
});

test('a transfer made between gameweeks marks a stored plan as outdated', () => {
  const base = frozen();
  const outId = base.picks[8].playerId;
  const inId = replacementFor(base, outId);

  const before = inputFingerprint(base, gameState);
  const after = inputFingerprint(withTransfers([row(outId, inId)]), gameState);
  assert.notEqual(before, after, 'the fingerprint has to see the squad change');

  const reason = outdatedReason(before, after);
  assert.ok(reason, 'and "check for changes" has to report it');
  assert.match(reason.text, /squad|player/i);
});

/* ------------------------------------------------------------ price moves */

test('a price change on a held player does not fire the value warning once a transfer has been made', () => {
  const base = frozen();
  const outId = base.picks[9].playerId;
  const inId = replacementFor(base, outId);
  const s = withTransfers([row(outId, inId)]);
  // FPL's frozen `value` describes the pre-transfer squad, so comparing against
  // it would warn on every manager who simply used their transfer.
  assert.equal(s.warnings.some(w => w.code === 'value_mismatch'), false, JSON.stringify(s.warnings));
  // and the reported value is the squad that now exists
  const sellingTotal = s.picks.reduce((sum, p) => sum + p.sellingTenths, 0);
  assert.equal(s.squadValueTenths, sellingTotal + s.bankTenths);
});

test('pendingTransfers reads only the window being planned', () => {
  const rows = [
    { element_out: 1, element_in: 2, event: PLAN_GW, time: 'b' },
    { element_out: 3, element_in: 4, event: PLAN_GW - 1, time: 'a' },
    { element_out: 5, element_in: 6, event: PLAN_GW, time: 'a' },
  ];
  const got = pendingTransfers({ transfers: rows, gw: PLAN_GW });
  assert.equal(got.length, 2);
  assert.deepEqual(got.map(t => t.element_in), [6, 2], 'and in time order');
});
