// Blank and double gameweek markers on player cards, and the IN/OUT ribbons.
//
// The committed sample dataset the demo runs on is pinned to a gameweek that
// has neither a blank nor a double, so these markers cannot be seen through
// `?demo=1` at all. The test fixtures do have both: one gameweek 5 fixture was
// moved into gameweek 6, so clubs 4 (BRE) and 6 (CHE) have no gameweek 5 game
// and two in gameweek 6. This file renders the real pitch (js/ui/pitch.js)
// against them and asserts the markers, instead of leaving them to a human who
// would have to wait for a real blank in the calendar.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { installDom, queryAll, query, classesOf, textOf, walk } from './helpers/mini-dom.mjs';
import { buildGameState } from '../js/engine/normalize.js';
import { buildSquadState } from '../js/engine/squad.js';
import { buildStrength } from '../js/engine/strength.js';
import { buildProjections } from '../js/engine/projections.js';
import { renderPitch } from '../js/ui/pitch.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

// Teardown restores the real globals when the file ends, the same pattern as
// ui-combobox.test.mjs: an installDom() left in place leaks a fake `document`
// into any suite the runner loads after this one in the same process.
const teardownDom = installDom();
after(() => teardownDom());

const BLANK_GW = 5;
const DOUBLE_GW = 6;

// From tests/fixtures/README.md: clubs 4 and 6 are the manufactured blank/double.
const KELLEHER = 82;    // GKP, club 4
const KAYODE = 88;      // DEF, club 4
const YARMOLIUK = 102;  // MID, club 4
const THIAGO = 106;     // FWD, club 4, not owned - the plan buys him
const GABRIEL = 4;      // DEF, club 1, plays in both gameweeks
const HAALAND = 411;    // FWD, club 15, plays in both gameweeks
const SEMENYO = 397;    // MID, club 15, owned - the plan sells him

const gameState = buildGameState(
  { ...read('bootstrap.json'), events: read('events-in-season.json') },
  read('fixtures.json'),
  { fetchedAt: '2026-09-24T10:00:00Z' },
);

const rawSquad = buildSquadState({
  entry: read('entry.json'),
  history: read('entry-history.json'),
  transfers: read('entry-transfers.json'),
  picks: read('entry-picks.json'),
  gameState,
  gw: DOUBLE_GW,
});

// The committed picks are grouped by position; FPL numbers a real squad 1-11 for
// the eleven that starts, 12 for the reserve keeper and 13-15 for the ordered
// outfield bench. The current-team view reads those slots, so it is given a
// squad laid out the way the API lays one out.
const squadState = (() => {
  const xi = [KELLEHER, GABRIEL, 113, KAYODE, 426, 13, YARMOLIUK, 212, HAALAND, 248, 249];
  const bench = [497, 204, 32, SEMENYO];
  const byId = new Map(rawSquad.picks.map(p => [p.playerId, p]));
  const ordered = [...xi, ...bench].map((id, i) => ({ ...byId.get(id), slot: i + 1 }));
  assert.equal(ordered.length, 15);
  assert.ok(ordered.every(p => p.playerId), 'every slot must map to a real pick');
  return { ...rawSquad, picks: ordered };
})();

const strength = buildStrength(gameState, { asOfGw: BLANK_GW - 1 });
const projections = buildProjections({
  gameState, strength, gwFrom: BLANK_GW, gwTo: DOUBLE_GW,
});

// One transfer: Semenyo out, Thiago in. Thiago is a club 4 player, so the card
// the plan asks the manager to buy is itself a blank/double card.
const plan = {
  gw: DOUBLE_GW,
  transfersOut: [SEMENYO],
  transfersIn: [THIAGO],
  startingXI: [KELLEHER, GABRIEL, 113, KAYODE, 426, 13, YARMOLIUK, 212, HAALAND, THIAGO, 248],
  formation: '3-4-3',
  bench: { gk: 497, order: [204, 32, 249] },
  captain: HAALAND,
  viceCaptain: 426,
};

function pitch(mode, gw) {
  return renderPitch({ mode, plan, squadState, gameState, projections, gw });
}

function cardFor(root, name) {
  const card = queryAll(root, 'fpl-pp').find(c => textOf(query(c, 'fpl-pp-name')) === name);
  if (!card) {
    const names = queryAll(root, 'fpl-pp').map(c => textOf(query(c, 'fpl-pp-name')));
    throw new Error(`no card for "${name}". Cards rendered: ${JSON.stringify(names)}`);
  }
  return card;
}

const chipsOn = (card) => queryAll(card, 'fpl-chip').map(c => ({ classes: [...classesOf(c)], text: textOf(c) }));
const chipText = (card, kind) => {
  const chip = queryAll(card, 'fpl-chip').find(c => classesOf(c).has(kind));
  return chip ? textOf(chip) : null;
};

test('a double gameweek is marked on the card, with how many fixtures', () => {
  const view = pitch('recommended', DOUBLE_GW);

  for (const name of ['Kelleher', 'Kayode', 'Yarmoliuk', 'Thiago']) {
    const card = cardFor(view, name);
    assert.equal(chipText(card, 'is-dgw'), 'DGW 2', `${name} plays twice in gameweek ${DOUBLE_GW}`);
    assert.equal(chipText(card, 'is-bgw'), null, `${name} is not blank`);
    assert.ok(!classesOf(card).has('is-blank'));
    // The fixture line names both opponents, so the badge is not the only place
    // the double is visible.
    assert.match(textOf(query(card, 'fpl-pp-fix')), /^[A-Z]{3} \([HA]\), [A-Z]{3} \([HA]\)$/);
  }
});

test('a player with one fixture carries no double or blank marker', () => {
  const view = pitch('recommended', DOUBLE_GW);
  for (const name of ['Gabriel', 'Haaland']) {
    const card = cardFor(view, name);
    assert.deepEqual(chipsOn(card), [], `${name} plays once, so the card stays plain`);
    assert.match(textOf(query(card, 'fpl-pp-fix')), /^[A-Z]{3} \([HA]\)$/);
  }
});

test('exactly the club 4 players are marked as a double, and nobody else', () => {
  const view = pitch('recommended', DOUBLE_GW);
  const doubled = queryAll(view, 'fpl-pp')
    .filter(c => chipText(c, 'is-dgw') !== null)
    .map(c => textOf(query(c, 'fpl-pp-name')))
    .sort();
  assert.deepEqual(doubled, ['Kayode', 'Kelleher', 'Thiago', 'Yarmoliuk']);
});

test('a blank gameweek is marked on the card, and the card says there is no fixture', () => {
  const view = pitch('recommended', BLANK_GW);

  for (const name of ['Kelleher', 'Kayode', 'Yarmoliuk', 'Thiago']) {
    const card = cardFor(view, name);
    assert.equal(chipText(card, 'is-blank'), null, 'the blank chip is is-bgw; is-blank is the card state');
    assert.equal(chipText(card, 'is-bgw'), 'Blank', `${name} has no gameweek ${BLANK_GW} fixture`);
    assert.equal(chipText(card, 'is-dgw'), null);
    assert.ok(classesOf(card).has('is-blank'), 'the whole card is styled as blank, not just badged');
    assert.equal(textOf(query(card, 'fpl-pp-fix')), 'No fixture');
    assert.equal(textOf(query(card, 'fpl-pp-xp')), '0.0xP', 'a player with no fixture is projected zero');
  }

  for (const name of ['Gabriel', 'Haaland']) {
    const card = cardFor(view, name);
    assert.deepEqual(chipsOn(card), []);
    assert.ok(!classesOf(card).has('is-blank'));
  }
});

test('the same squad flips between blank and double as the gameweek moves', () => {
  const blank = cardFor(pitch('recommended', BLANK_GW), 'Kayode');
  const double = cardFor(pitch('recommended', DOUBLE_GW), 'Kayode');
  assert.equal(chipText(blank, 'is-bgw'), 'Blank');
  assert.equal(chipText(double, 'is-dgw'), 'DGW 2');
  assert.notEqual(textOf(query(blank, 'fpl-pp-xp')), textOf(query(double, 'fpl-pp-xp')));
});

test('the legend tells the reader where the markers come from', () => {
  const view = pitch('recommended', DOUBLE_GW);
  const legend = query(view, 'fpl-pitch-legend');
  assert.match(textOf(legend), /DGW \/ Blank from the fixture list/);
  assert.match(textOf(legend), /IN marks a player the plan buys/);
  const currentLegend = query(pitch('current', DOUBLE_GW), 'fpl-pitch-legend');
  assert.match(textOf(currentLegend), /OUT marks a player the plan sells/);
});

/* ------------------------------------------------------------ IN/OUT ribbons */

const ribbon = (card) => {
  const move = queryAll(card, 'fpl-pp-move')[0];
  return move ? { kind: classesOf(move).has('is-in') ? 'in' : 'out', text: textOf(move) } : null;
};

test('a player the plan keeps carries no ribbon on either view', () => {
  // The claim that mattered on the pitch: only a player actually moving is
  // marked, so a held player is never mistaken for a transfer.
  for (const mode of ['current', 'recommended']) {
    const view = pitch(mode, DOUBLE_GW);
    for (const name of ['Kayode', 'Gabriel', 'Haaland', 'Kelleher']) {
      assert.equal(ribbon(cardFor(view, name)), null, `${name} is held, so no ribbon on the ${mode} view`);
    }
  }
});

test('the current view marks only what the plan sells, the recommended view only what it buys', () => {
  const current = pitch('current', DOUBLE_GW);
  const recommended = pitch('recommended', DOUBLE_GW);

  assert.deepEqual(ribbon(cardFor(current, 'Semenyo')), { kind: 'out', text: 'OUT' });
  assert.equal(
    queryAll(current, 'fpl-pp').filter(c => ribbon(c)).length, 1,
    'one transfer out, one ribbon',
  );
  assert.throws(() => cardFor(current, 'Thiago'), /no card for "Thiago"/, 'a player not yet owned is not on the current pitch');

  assert.deepEqual(ribbon(cardFor(recommended, 'Thiago')), { kind: 'in', text: 'IN' });
  assert.equal(queryAll(recommended, 'fpl-pp').filter(c => ribbon(c)).length, 1);
  assert.throws(() => cardFor(recommended, 'Semenyo'), /no card for "Semenyo"/, 'a sold player is gone, not benched');
});

test('every rendered card has the four lines a card promises', () => {
  const view = pitch('recommended', DOUBLE_GW);
  const cards = queryAll(view, 'fpl-pp');
  assert.equal(cards.length, 15, 'eleven on the pitch plus four on the bench');
  for (const card of cards) {
    assert.ok(textOf(query(card, 'fpl-pp-name')));
    assert.match(textOf(query(card, 'fpl-pp-meta')), /^[A-Z]{3} · (GKP|DEF|MID|FWD) · £\d+\.\dm$/);
    assert.ok(textOf(query(card, 'fpl-pp-fix')));
    assert.match(textOf(query(card, 'fpl-pp-xp')), /^-?\d+\.\dxP$/);
  }
  assert.equal([...walk(view)].filter(n => classesOf(n).has('fpl-bench-slot')).length, 4);
});
