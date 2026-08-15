// The squad table's pure layer: the row records the table is built from, and
// the sort that reorders them.
//
// renderSquadTable is presentation over these two functions plus dom.js, and
// the browser suites exercise the rendered table; what needs pinning here is
// the DATA story. A row record that silently drops the captaincy, prices a
// player from the wrong field or sums a horizon across a missing gameweek
// produces a table full of plausible wrong numbers, which is this app's
// signature failure mode.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { squadTableRows, sortSquadRows } from '../js/ui/squad-table.js';

// A hand-built GameState small enough to reason about: two clubs, six players,
// one injured, one doubtful, one with no ownership figure. Field names follow
// js/engine/normalize.js (webName, nowCost in tenths, selectedByPercent).
const rules = {
  positions: {
    1: { id: 1, short: 'GKP' },
    2: { id: 2, short: 'DEF' },
    3: { id: 3, short: 'MID' },
    4: { id: 4, short: 'FWD' },
  },
};

const players = new Map([
  [1, { id: 1, webName: 'Keeper', teamId: 1, position: 1, nowCost: 45, status: 'a', news: '', selectedByPercent: 12.3 }],
  [2, { id: 2, webName: 'Back', teamId: 1, position: 2, nowCost: 52, status: 'a', news: '', selectedByPercent: 30.1 }],
  [3, { id: 3, webName: 'Wide', teamId: 2, position: 3, nowCost: 78, status: 'd', chanceNext: 0.75, news: 'Knock', selectedByPercent: 44.0 }],
  [4, { id: 4, webName: 'Striker', teamId: 2, position: 4, nowCost: 125, status: 'a', news: '', selectedByPercent: 61.9 }],
  [5, { id: 5, webName: 'SubGk', teamId: 2, position: 1, nowCost: 40, status: 'a', news: '', selectedByPercent: Number.NaN }],
  [6, { id: 6, webName: 'Crocked', teamId: 1, position: 2, nowCost: 44, status: 'i', news: 'Hamstring', selectedByPercent: 5.0 }],
]);

const teams = new Map([
  [1, { id: 1, shortName: 'AAA', name: 'Alpha Athletic' }],
  [2, { id: 2, shortName: 'BBB', name: 'Beta Borough' }],
]);

const gameState = { rules, players, teams };

const GW = 10;
// Projection rows in the wire shape the UI reads (plain byPlayer object,
// gwFrom-indexed arrays). Player 3 has a blank at GW 11 (no fixtures) and no
// row at all for GW 12; player 5 has no projections at all.
const projections = {
  gwFrom: GW,
  byPlayer: {
    1: [row(GW, 3.1, [{ opponentId: 2, isHome: true }])],
    2: [row(GW, 2.4, [{ opponentId: 2, isHome: false }]), row(GW + 1, 3.6, [{ opponentId: 2, isHome: true }])],
    3: [row(GW, 5.5, [{ opponentId: 1, isHome: true }]), row(GW + 1, 0, []), null],
    4: [row(GW, 7.2, [{ opponentId: 1, isHome: false }, { opponentId: 1, isHome: true }]), row(GW + 1, 6.1, [{ opponentId: 1, isHome: true }]), row(GW + 2, 4.7, [{ opponentId: 1, isHome: false }])],
    6: [row(GW, 0.4, [{ opponentId: 2, isHome: true }])],
  },
};

function row(gw, xPoints, fixtures) {
  return { gw, xPoints, fixtures };
}

const vm = {
  startingXI: [1, 2, 3, 4],
  bench: { gk: 5, order: [6] },
  captain: 4,
  viceCaptain: 3,
  movesIn: new Set([3]),
  movesOut: new Set([6]),
};

const rows = squadTableRows({ vm, gameState, projections, gw: GW, horizon: 3 });
const byId = (id) => rows.find(r => r.id === id);

test('rows come out XI first, then the bench in its order', () => {
  assert.deepEqual(rows.map(r => r.id), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(rows.map(r => r.role), ['xi', 'xi', 'xi', 'xi', 'bench', 'bench']);
  // The bench keeper is bench slot 0 and the outfield sub follows him.
  assert.equal(byId(5).benchIndex, 0);
  assert.equal(byId(6).benchIndex, 1);
  assert.equal(byId(1).benchIndex, null);
});

test('the armbands and the transfer marks land on the right players and only them', () => {
  assert.equal(byId(4).isCaptain, true);
  assert.equal(byId(3).isVice, true);
  assert.equal(rows.filter(r => r.isCaptain).length, 1);
  assert.equal(rows.filter(r => r.isVice).length, 1);
  assert.equal(byId(3).move, 'in');
  assert.equal(byId(6).move, 'out');
  assert.deepEqual(rows.filter(r => r.move === null).map(r => r.id), [1, 2, 4, 5]);
});

test('identity columns come from the game state, money stays in tenths', () => {
  const striker = byId(4);
  assert.equal(striker.name, 'Striker');
  assert.equal(striker.club, 'BBB');
  assert.equal(striker.positionShort, 'FWD');
  assert.equal(striker.price, 125, 'priceTenths, never a float of millions');
  assert.equal(striker.ownership, 61.9);
  // An ownership FPL did not publish is null, not 0: the render layer shows
  // "-" for null and would show a lie for 0.
  assert.equal(byId(5).ownership, null);
});

test('this-gameweek xP is the projection row or null, never a guessed number', () => {
  assert.equal(byId(4).xpGw, 7.2);
  assert.equal(byId(5).xpGw, null, 'no projection row means no number');
});

test('the horizon xP is the sum over exactly the projected gameweeks', () => {
  // Player 4 has all three rows.
  assert.ok(Math.abs(byId(4).xpHorizon - (7.2 + 6.1 + 4.7)) < 1e-9);
  // Player 2 has two of three: the missing week contributes nothing rather
  // than NaN-ing the sum.
  assert.ok(Math.abs(byId(2).xpHorizon - (2.4 + 3.6)) < 1e-9);
  // Player 3's blank week is a real 0 and his missing third week is skipped.
  assert.ok(Math.abs(byId(3).xpHorizon - 5.5) < 1e-9);
  assert.equal(byId(5).xpHorizon, 0);
});

test('fixtures render as the label the pitch uses, blanks say so explicitly', () => {
  assert.equal(byId(1).fixtures, 'BBB (H)');
  assert.equal(byId(4).fixtures, 'AAA (A), AAA (H)', 'a double gameweek lists both');
  assert.equal(byId(5).fixtures, 'No fixture');
  assert.equal(byId(5).isBlank, false, 'no row at all is not a blank, it is unprojected');
  // A row that exists with zero fixtures IS a blank; check via the GW-11 shape.
  const nextGwRows = squadTableRows({ vm, gameState, projections, gw: GW + 1, horizon: 1 });
  assert.equal(nextGwRows.find(r => r.id === 3).isBlank, true);
  assert.equal(nextGwRows.find(r => r.id === 3).fixtures, 'No fixture');
});

test('availability travels with the row for the injured and the doubtful only', () => {
  assert.equal(byId(6).avail.kind, 'out');
  assert.equal(byId(6).avail.label, 'Injured');
  assert.equal(byId(3).avail.kind, 'doubt');
  assert.equal(byId(3).avail.label, '75% fit');
  assert.equal(byId(4).avail, null);
});

test('a vm without a bench still produces the eleven', () => {
  const xiOnly = squadTableRows({
    vm: { ...vm, bench: null }, gameState, projections, gw: GW, horizon: 1,
  });
  assert.deepEqual(xiOnly.map(r => r.id), [1, 2, 3, 4]);
});

/* ------------------------------------------------------------------- sort */

test('numeric sort orders by value in both directions and does not mutate', () => {
  const before = rows.map(r => r.id);
  const desc = sortSquadRows(rows, 'price', 'desc');
  assert.deepEqual(desc.map(r => r.id), [4, 3, 2, 1, 6, 5]);
  const asc = sortSquadRows(rows, 'price', 'asc');
  assert.deepEqual(asc.map(r => r.id), [5, 6, 1, 2, 3, 4]);
  assert.deepEqual(rows.map(r => r.id), before, 'sorting returns a copy');
});

test('string sort uses locale comparison with the direction applied', () => {
  const asc = sortSquadRows(rows, 'name', 'asc');
  assert.deepEqual(asc.map(r => r.name), ['Back', 'Crocked', 'Keeper', 'Striker', 'SubGk', 'Wide']);
  const desc = sortSquadRows(rows, 'name', 'desc');
  assert.deepEqual(desc.map(r => r.name), ['Wide', 'SubGk', 'Striker', 'Keeper', 'Crocked', 'Back']);
});

test('rows without a value sink to the bottom whichever way the sort runs', () => {
  // Player 5 has xpGw null and ownership null; a null must never sort as 0 and
  // float to the top of an ascending column.
  for (const dir of ['asc', 'desc']) {
    const sorted = sortSquadRows(rows, 'xpGw', dir);
    assert.equal(sorted[sorted.length - 1].id, 5, `null xpGw last when sorting ${dir}`);
    const own = sortSquadRows(rows, 'ownership', dir);
    assert.equal(own[own.length - 1].id, 5, `null ownership last when sorting ${dir}`);
  }
});
