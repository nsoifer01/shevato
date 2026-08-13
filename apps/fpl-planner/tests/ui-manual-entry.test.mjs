// The manual squad builder's live search, add, remove and running counters.
//
// This is the pre-season path for a manager who does not want the optimizer to
// draft for them. It was previously only checkable by hand because it is driven
// by an input event and a list of buttons that re-render after every click.
// Both of those are DOM plumbing, not browser behaviour, so the whole flow runs
// here against the real view (js/ui/preseason.js): value + `input` event to
// search, click to add, click to remove, and the counters read back after each
// step.
//
// What is deliberately NOT claimed here: real keystrokes, focus, IME and the
// mobile keyboard. Those stay in .features/fpl-planner-human.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { installDom, query, queryAll, textOf, walk, click, typeInto, buttonWith } from './helpers/mini-dom.mjs';
import { buildGameState } from '../js/engine/normalize.js';
import { manualSquadView } from '../js/ui/preseason.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

installDom();

const gameState = buildGameState(read('bootstrap.json'), read('fixtures.json'), { fetchedAt: '2026-08-10T10:00:00Z' });

// A legal 15 out of the fixture pool: 2 GKP, 5 DEF, 5 MID, 3 FWD, £99.6m spent,
// no more than three from any club.
const LEGAL_15 = [82, 497, 4, 204, 113, 32, 88, 426, 397, 13, 102, 212, 411, 248, 249];

function mount({ initialIds = [] } = {}) {
  const planned = [];
  const view = manualSquadView({
    gameState,
    initialIds,
    onPlan: (ids) => planned.push(ids),
    onCancel: () => {},
  });
  return { view, planned };
}

const searchBox = (view) => [...walk(view)].find(n => n.tagName === 'INPUT');
const resultRows = (view) => queryAll(view, 'fpl-sr');
const resultNames = (view) => resultRows(view).map(r => textOf(query(r, 'fpl-sr-name')));
const pickedNames = (view) => queryAll(view, 'fpl-picked-item').map(p => textOf(p).replace(/×$/, '').trim());

function counters(view) {
  return Object.fromEntries(queryAll(view, 'fpl-counter').map(c => [
    textOf(query(c, 'fpl-counter-k')),
    textOf(query(c, 'fpl-counter-v')),
  ]));
}

function rowFor(view, name) {
  const row = resultRows(view).find(r => textOf(query(r, 'fpl-sr-name')) === name);
  assert.ok(row, `"${name}" is not in the result list: ${JSON.stringify(resultNames(view))}`);
  return row;
}

const addButton = (row) => query(row, 'fpl-btn');

test('an empty squad starts at zero, with the whole budget and nothing picked', () => {
  const { view } = mount();
  assert.deepEqual(counters(view), {
    GKP: '0/2', DEF: '0/5', MID: '0/5', FWD: '0/3', Remaining: '£100.0m', Spent: '£0.0m',
  });
  assert.equal(textOf(query(view, 'fpl-legality-ok')), 'Legal so far. 15 more players to pick.');
  assert.deepEqual(pickedNames(view), []);
  assert.ok(resultRows(view).length > 1, 'the search list starts populated, not empty');
});

test('typing narrows the result list as you go', () => {
  const { view } = mount();
  const before = resultNames(view);

  typeInto(searchBox(view), 'haa');
  assert.deepEqual(resultNames(view), ['Haaland']);

  typeInto(searchBox(view), 'haaland-who-does-not-exist');
  assert.deepEqual(resultNames(view), [], 'no match is an empty list, not the whole pool');

  typeInto(searchBox(view), '');
  assert.deepEqual(resultNames(view), before, 'clearing the box restores the list');
});

test('adding a player moves the counters, the money and the picked list at once', async () => {
  const { view } = mount();
  typeInto(searchBox(view), 'haa');
  const row = rowFor(view, 'Haaland');
  assert.equal(textOf(addButton(row)), 'Add');

  await click(addButton(row));

  assert.deepEqual(counters(view), {
    GKP: '0/2', DEF: '0/5', MID: '0/5', FWD: '1/3', Remaining: '£84.5m', Spent: '£15.5m',
  });
  assert.deepEqual(pickedNames(view), ['Haaland £15.5m']);
  assert.equal(textOf(query(view, 'fpl-legality-ok')), 'Legal so far. 14 more players to pick.');
  // The list is redrawn after the click, so the same player can no longer be
  // added twice.
  const redrawn = rowFor(view, 'Haaland');
  assert.equal(textOf(addButton(redrawn)), 'Added');
  assert.equal(addButton(redrawn).disabled, true);
});

test('removing a player puts the counters and the money back exactly', async () => {
  const { view } = mount();
  const before = counters(view);

  typeInto(searchBox(view), 'haa');
  await click(addButton(rowFor(view, 'Haaland')));
  assert.notDeepEqual(counters(view), before);

  const remove = query(query(view, 'fpl-picked'), 'fpl-btn');
  assert.equal(textOf(remove), '×');
  await click(remove);

  assert.deepEqual(counters(view), before);
  assert.deepEqual(pickedNames(view), []);
  assert.equal(textOf(addButton(rowFor(view, 'Haaland'))), 'Add', 'and he can be added again');
});

test('a fourth player from the same club is offered but blocked, with the reason on the control', async () => {
  const { view } = mount();
  const club4 = ['Kelleher', 'Kayode', 'Yarmoliuk'];   // all BRE
  for (const name of club4) {
    typeInto(searchBox(view), name.toLowerCase());
    await click(addButton(rowFor(view, name)));
  }

  typeInto(searchBox(view), 'milambo');   // a fourth BRE player
  const blocked = addButton(rowFor(view, 'Milambo'));
  assert.equal(textOf(blocked), 'Blocked');
  assert.equal(blocked.disabled, true);
  assert.equal(blocked.getAttribute('title'), 'Already 3 from that club.');
  assert.deepEqual(pickedNames(view).length, 3);
});

test('the plan button unlocks only once the squad is legal, and hands back the fifteen', async () => {
  const { view, planned } = mount({ initialIds: LEGAL_15.slice(0, 14) });
  const planBtn = buttonWith(view, 'Plan with this squad');
  assert.equal(planBtn.disabled, true, '14 players is not a squad');
  assert.equal(textOf(query(view, 'fpl-legality-ok')), 'Legal so far. 1 more player to pick.');

  typeInto(searchBox(view), 'barry');
  await click(addButton(rowFor(view, 'Barry')));

  assert.equal(planBtn.disabled, false);
  assert.equal(textOf(query(view, 'fpl-legality-ok')), 'Legal squad. Ready to plan.');
  assert.deepEqual(counters(view), {
    GKP: '2/2', DEF: '5/5', MID: '5/5', FWD: '3/3', Remaining: '£0.4m', Spent: '£99.6m',
  });

  await click(planBtn);
  assert.deepEqual(planned, [LEGAL_15]);
});

test('an illegal squad says what is wrong instead of silently refusing', async () => {
  // Six defenders: one more than the game allows.
  const sixDefenders = [4, 204, 113, 32, 88, 30];
  const { view } = mount({ initialIds: sixDefenders.slice(0, 5) });
  assert.equal(query(view, 'fpl-legality-bad'), null, 'five defenders is legal');

  const { view: over } = mount({ initialIds: sixDefenders });
  const issues = queryAll(over, 'fpl-legality-bad').map(u => textOf(u));
  assert.equal(issues.length, 1);
  assert.match(issues[0], /6 DEF selected, the maximum is 5\./);
  assert.equal(buttonWith(over, 'Plan with this squad').disabled, true);
});
