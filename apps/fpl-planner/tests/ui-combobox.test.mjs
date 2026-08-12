// combobox.js - the searchable player picker.
//
// THE TEST THIS FILE EXISTS FOR: the keyboard model IS the control. A listbox
// that renders correctly but cannot be driven with the arrow keys, or that moves
// DOM focus into the list and so silences aria-activedescendant, is not an
// accessible combobox no matter what its markup says.
//
// So the assertions below drive the real module through real keydown events and
// check the ARIA state a screen reader would read afterwards, rather than
// inspecting the initial markup and calling it compliant.
//
// WHAT IS NOT TESTED HERE, deliberately: real focus, real typing, and whether a
// mobile keyboard covers the list. Those need a browser and a person, and they
// live in .features/fpl-planner-human.md.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDom, walk, queryAll, textOf, fire, pressKey, classesOf } from './helpers/mini-dom.mjs';
import { combobox, COMBOBOX_PARAMS } from '../js/ui/combobox.js';

const teardown = installDom();
test.after(() => teardown());

const PLAYERS = [
  { id: 1, label: 'Haaland', meta: 'MCI · FWD · £15.4m', trailing: '5.2 xP', search: 'haaland erling mci man city fwd' },
  { id: 2, label: 'Saka', meta: 'ARS · MID · £9.6m', trailing: '4.7 xP', search: 'saka bukayo ars arsenal mid' },
  { id: 3, label: 'Palmer', meta: 'CHE · MID · £9.2m', trailing: '4.4 xP', search: 'palmer cole che chelsea mid' },
  { id: 4, label: 'Gabriel', meta: 'ARS · DEF · £8.0m', trailing: '4.1 xP', search: 'gabriel ars arsenal def' },
  { id: 5, label: 'Rice', meta: 'ARS · MID · £6.5m', trailing: '3.6 xP', search: 'rice declan ars arsenal mid' },
];

function make(over = {}) {
  const chosen = [];
  const cb = combobox({
    items: PLAYERS,
    label: 'Search for a player by name, club or position',
    placeholder: 'Search 5 players',
    onSelect: item => chosen.push(item),
    ...over,
  });
  return { cb, chosen };
}

const options = cb => [...walk(cb.list)].filter(n => n.getAttribute('role') === 'option');
const activeOption = cb => options(cb).find(o => o.getAttribute('aria-selected') === 'true') || null;

async function type(cb, value) {
  cb.input.value = value;
  await fire(cb.input, 'input');
}

/* -------------------------------------------------------------------- aria */

test('the closed control announces itself as a collapsed combobox owning a listbox', () => {
  const { cb } = make();
  assert.equal(cb.input.getAttribute('role'), 'combobox');
  assert.equal(cb.input.getAttribute('aria-expanded'), 'false');
  assert.equal(cb.input.getAttribute('aria-autocomplete'), 'list');
  assert.equal(cb.input.getAttribute('aria-haspopup'), 'listbox');
  assert.ok(cb.input.getAttribute('aria-label'), 'the field is labelled for a screen reader');

  // aria-controls has to name a node that exists, or it points nowhere.
  const controls = cb.input.getAttribute('aria-controls');
  assert.equal(cb.list.getAttribute('id'), controls);
  assert.equal(cb.list.getAttribute('role'), 'listbox');
  assert.equal(cb.list.hidden, true, 'the popup starts closed');
  assert.equal(cb.input.getAttribute('aria-activedescendant'), null, 'nothing is active while closed');
});

test('every rendered row is an option with an id, and the active one is the one aria points at', async () => {
  const { cb } = make();
  await type(cb, 'ars');

  const rows = options(cb);
  assert.equal(rows.length, 3, 'Saka, Gabriel and Rice');
  for (const rowNode of rows) {
    assert.ok(rowNode.getAttribute('id'), 'an option a combobox can point at needs an id');
    assert.ok(['true', 'false'].includes(rowNode.getAttribute('aria-selected')));
  }

  assert.equal(cb.input.getAttribute('aria-expanded'), 'true');
  const pointed = cb.input.getAttribute('aria-activedescendant');
  assert.equal(pointed, rows[0].getAttribute('id'), 'typing pre-arms the first row');
  assert.equal(activeOption(cb), rows[0]);
});

test('DOM focus never moves into the list, which is what makes aria-activedescendant the cue', async () => {
  const { cb } = make();
  await type(cb, 'a');
  await pressKey(cb.input, 'ArrowDown');
  await pressKey(cb.input, 'ArrowDown');

  // No option is focusable: no tabindex, and nothing is a button or a link.
  for (const rowNode of options(cb)) {
    assert.equal(rowNode.getAttribute('tabindex'), null, 'options must not be tab stops');
    assert.equal(rowNode.tagName, 'LI');
  }
  assert.ok(cb.input.getAttribute('aria-activedescendant'), 'the active row is named instead');
});

test('the result count is announced in a polite live region, not just drawn', async () => {
  const { cb } = make();
  const live = [...walk(cb.node)].find(n => n.getAttribute('aria-live') === 'polite');
  assert.ok(live, 'there is a live region');
  assert.equal(live.getAttribute('role'), 'status');

  await type(cb, 'ars');
  assert.match(textOf(live), /3 players match/);
  assert.match(textOf(live), /arrow keys/, 'and it says how to use the list');

  await type(cb, 'zzz');
  assert.match(textOf(live), /No player matches/);
});

test('the announcement says how many were found and how many are shown when the list is capped', async () => {
  const many = [];
  for (let i = 0; i < COMBOBOX_PARAMS.maxRendered + 30; i++) {
    many.push({ id: i + 1, label: `Player ${i}`, meta: 'CLB · MID · £5.0m', search: 'midfielder' });
  }
  const cb = combobox({ items: many, label: 'Search' });
  const live = [...walk(cb.node)].find(n => n.getAttribute('aria-live') === 'polite');
  cb.input.value = 'midfielder';
  await fire(cb.input, 'input');

  assert.equal(options(cb).length, COMBOBOX_PARAMS.maxRendered, 'rendering is capped');
  assert.match(textOf(live), new RegExp(`${many.length} players match`), 'the true total is announced');
  assert.match(textOf(live), new RegExp(`first ${COMBOBOX_PARAMS.maxRendered}`));
});

/* ---------------------------------------------------------------- keyboard */

test('ArrowDown opens a closed list and lands on the first option', async () => {
  const { cb } = make();
  assert.equal(cb.isOpen, false);
  await pressKey(cb.input, 'ArrowDown');
  assert.equal(cb.isOpen, true);
  assert.equal(cb.activeIndex, 0);
  assert.equal(cb.input.getAttribute('aria-expanded'), 'true');
});

test('ArrowUp opens a closed list and lands on the last option', async () => {
  const { cb } = make();
  await pressKey(cb.input, 'ArrowUp');
  assert.equal(cb.isOpen, true);
  assert.equal(cb.activeIndex, cb.matches.length - 1);
});

test('the arrows wrap at both ends rather than sticking', async () => {
  const { cb } = make();
  await type(cb, 'ars');
  assert.equal(cb.activeIndex, 0);

  await pressKey(cb.input, 'ArrowUp');
  assert.equal(cb.activeIndex, 2, 'up from the first wraps to the last');
  await pressKey(cb.input, 'ArrowDown');
  assert.equal(cb.activeIndex, 0, 'down from the last wraps to the first');
});

test('Home and End jump to the ends of the list', async () => {
  const { cb } = make();
  await type(cb, 'ars');
  await pressKey(cb.input, 'End');
  assert.equal(cb.activeIndex, 2);
  await pressKey(cb.input, 'Home');
  assert.equal(cb.activeIndex, 0);
});

test('Enter chooses the active option, fills the field and closes the list', async () => {
  const { cb, chosen } = make();
  await type(cb, 'ars');
  await pressKey(cb.input, 'ArrowDown');
  const expected = cb.matches[cb.activeIndex];

  await pressKey(cb.input, 'Enter');
  assert.deepEqual(chosen, [expected]);
  assert.equal(cb.value.id, expected.id);
  assert.equal(cb.input.value, expected.label);
  assert.equal(cb.isOpen, false);
  assert.equal(cb.list.hidden, true);
  assert.equal(cb.input.getAttribute('aria-expanded'), 'false');
  assert.equal(cb.input.getAttribute('aria-activedescendant'), null);
});

test('Enter on a closed list does nothing, so it cannot submit a stale choice', async () => {
  const { cb, chosen } = make();
  const event = await pressKey(cb.input, 'Enter');
  assert.equal(chosen.length, 0);
  assert.equal(event.defaultPrevented, false, 'and it lets the key through to the page');
});

test('Escape closes the list first and clears the field only on a second press', async () => {
  const { cb } = make();
  await type(cb, 'ars');
  assert.equal(cb.isOpen, true);

  await pressKey(cb.input, 'Escape');
  assert.equal(cb.isOpen, false, 'first Escape closes');
  assert.equal(cb.input.value, 'ars', 'and keeps what was typed');

  await pressKey(cb.input, 'Escape');
  assert.equal(cb.input.value, '', 'second Escape clears');
});

test('Tab closes the list without choosing anything', async () => {
  const { cb, chosen } = make();
  await type(cb, 'ars');
  await pressKey(cb.input, 'ArrowDown');
  await pressKey(cb.input, 'Tab');
  assert.equal(cb.isOpen, false);
  assert.equal(chosen.length, 0, 'tabbing away is not a selection');
  assert.equal(cb.value, null);
});

test('the navigation keys are prevented from also scrolling the page', async () => {
  const { cb } = make();
  await type(cb, 'ars');
  for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
    const event = await pressKey(cb.input, key);
    assert.equal(event.defaultPrevented, true, `${key} must not scroll the page as well`);
  }
});

/* ------------------------------------------------------------------ search */

test('search matches name, club and position, and every token has to hit', async () => {
  const { cb } = make();

  await type(cb, 'bukayo');
  assert.deepEqual(cb.matches.map(m => m.label), ['Saka'], 'full name, not just the display name');

  await type(cb, 'che');
  assert.deepEqual(cb.matches.map(m => m.label), ['Palmer'], 'club');

  await type(cb, 'ars mid');
  assert.deepEqual(cb.matches.map(m => m.label), ['Saka', 'Rice'], 'club and position together');

  await type(cb, 'ars keeper');
  assert.deepEqual(cb.matches, [], 'a token that misses excludes the row');
});

test('an empty query shows the list rather than nothing', async () => {
  const { cb } = make();
  await type(cb, 'ars');
  await type(cb, '');
  assert.equal(cb.matches.length, PLAYERS.length);
});

test('each row carries the name, the club, position and price, and the projection', async () => {
  const { cb } = make();
  await type(cb, 'haaland');
  const row = options(cb)[0];
  assert.equal(textOf(queryAll(row, 'fpl-cb-name')[0]), 'Haaland');
  assert.equal(textOf(queryAll(row, 'fpl-cb-meta')[0]), 'MCI · FWD · £15.4m');
  assert.equal(textOf(queryAll(row, 'fpl-cb-trail')[0]), '5.2 xP');
});

test('the active row is marked with a class as well as with aria, so it is visible', async () => {
  const { cb } = make();
  await type(cb, 'ars');
  await pressKey(cb.input, 'End');
  const rows = options(cb);
  assert.ok(classesOf(rows[2]).has('is-active'));
  assert.ok(!classesOf(rows[0]).has('is-active'));
});

test('clicking a row selects it without letting the input lose focus first', async () => {
  const { cb, chosen } = make();
  await type(cb, 'ars');
  const row = options(cb)[1];
  const event = await fire(row, 'mousedown');
  assert.equal(event.defaultPrevented, true, 'mousedown is prevented so focus stays in the field');
  assert.equal(chosen.length, 1);
  assert.equal(cb.input.value, chosen[0].label);
  assert.equal(cb.isOpen, false);
});

test('typing after a selection clears the selection, so a stale player cannot be submitted', async () => {
  const { cb } = make();
  await type(cb, 'saka');
  await pressKey(cb.input, 'Enter');
  assert.ok(cb.value);
  await type(cb, 'sak');
  assert.equal(cb.value, null);
});

test('clear() resets the field, the selection and the popup together', async () => {
  const { cb } = make();
  await type(cb, 'saka');
  await pressKey(cb.input, 'Enter');
  cb.clear();
  assert.equal(cb.input.value, '');
  assert.equal(cb.value, null);
  assert.equal(cb.isOpen, false);
  assert.equal(cb.list.hidden, true);
});

// The rows the app actually feeds it. Kept in this file because the contract
// between the picker and the combobox is what these fields ARE.
test('the app builds a row per player, flags the unavailable, and hides nobody', async () => {
  const { playerPickerItems } = await import('../js/ui/dashboard.js');
  const gameState = {
    rules: { positions: { 2: { id: 2, short: 'DEF', name: 'Defender' } } },
    teams: new Map([[7, { id: 7, name: 'Aston Villa', shortName: 'AVL' }]]),
    players: new Map([
      [30, { id: 30, webName: 'Digne', firstName: 'Lucas', secondName: 'Digne', teamId: 7, position: 2, nowCost: 46, status: 'u', news: 'Has left the club', chanceNext: null }],
      [31, { id: 31, webName: 'Konsa', firstName: 'Ezri', secondName: 'Konsa', teamId: 7, position: 2, nowCost: 45, status: 'a', news: '', chanceNext: null }],
    ]),
  };
  const bundle = { current: { gw: 13 }, projections: { gwFrom: 13, byPlayer: new Map([[31, [{ xPoints: 4.2 }]]]) } };

  const items = playerPickerItems({ bundle, gameState });
  assert.equal(items.length, 2, 'a player the game will not sell is still listed');

  const digne = items.find(i => i.id === 30);
  assert.match(digne.meta, /Unavailable/, 'and is flagged before the user asks');
  assert.match(digne.search, /unavailable/);
  // Searching for him has to find him: "no player matches that search" would
  // read as a broken search rather than as a player who has left the league.
  assert.ok(digne.search.includes('lucas'));

  const konsa = items.find(i => i.id === 31);
  assert.equal(konsa.trailing, '4.2 xP');
  assert.equal(konsa.meta, 'AVL · DEF · £4.5m');
});

test('two comboboxes on one page do not share option ids', () => {
  const a = combobox({ items: PLAYERS, label: 'A' });
  const b = combobox({ items: PLAYERS, label: 'B' });
  assert.notEqual(a.list.getAttribute('id'), b.list.getAttribute('id'));
  assert.notEqual(a.input.getAttribute('id'), b.input.getAttribute('id'));
});
