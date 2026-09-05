// The price-change badges, rendered through the real transfer card and the
// real drawer under the repo's mini DOM (the ui-dashboard.test.mjs pattern).
//
// WHY RENDERED TESTS AND NOT MODEL TESTS: engine/price-change.js is already
// pinned by tests/price-change.test.mjs. What is NOT provable from the model is
// whether the card puts the right words on screen for the right side of a
// transfer, and the asymmetry (urgent for a rise you are buying, quiet for one
// you are selling) lives entirely in that wiring. A locked player rendering
// "Rise tonight" would be the app promising a move the game forbids, so that
// case is asserted off the rendered text rather than off the model.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom, query, queryAll, textOf } from './helpers/mini-dom.mjs';

const teardownDom = installDom();
after(() => teardownDom());

const { assembleSampleBundle } = await import('../js/data/sample.js');
const { buildGameState, normalizePriceChange } = await import('../js/engine/normalize.js');
const { buildSquadState } = await import('../js/engine/squad.js');
const { buildPlan } = await import('../js/engine/planner.js');
const { transfersCard } = await import('../js/ui/dashboard.js');
const { drawerBodyForTest } = await import('../js/ui/player-drawer.js');
const { readPriceChange } = await import('../js/engine/price-change.js');

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const sample = (name) => JSON.parse(readFileSync(join(APP, 'data', 'sample', `${name}.json`), 'utf8'));
const names = ['meta', 'bootstrap', 'fixtures', 'entry', 'entry-history', 'entry-transfers', 'entry-picks'];
const files = assembleSampleBundle(Object.fromEntries(names.map(n => [n, sample(n)])));

const sampleState = buildGameState(files.bootstrap, files.fixtures, { fetchedAt: files.fetchedAt });
const gw = files.planEvent;

// The sample dataset SHIPS price-change data so ?demo=1 demonstrates the
// feature. These tests are about what the card renders for ONE painted signal,
// so they start from a stripped world and add exactly what each case needs.
// Without this, every card would already be covered in demo chips and no
// assertion about absence would mean anything.
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
const bundle = await buildPlan({ gameState: baseState, squadState, options: { horizon: 3, seed: 7 } });
const plan = bundle.current;

// The sample payload predates the price-change fields, so the plan below is
// computed WITHOUT them and the fields are then painted onto the two players
// the plan actually moves. That keeps every test here about rendering.
const pair = (() => {
  const outIds = plan.transfersOut || [];
  const inIds = plan.transfersIn || [];
  assert.ok(outIds.length && inIds.length, 'the sample plan must make a transfer for these tests to mean anything');
  return { out: outIds[0], in: inIds[0] };
})();

const DEADLINES = [
  '2026-09-05T23:00:00Z',
  '2026-09-06T23:00:00Z',
  '2026-09-07T23:00:00Z',
].map(d => new Date(d).toISOString());
const NOW = Date.parse('2026-09-05T21:30:00Z');

const RISE_TONIGHT = {
  price_change_percent: '96.0',
  price_change_projections: [{ offset: 0, projected_percent: '112.0', likelihood: 5 }],
};
const FALL_TONIGHT = {
  price_change_percent: '-96.0',
  price_change_projections: [{ offset: 0, projected_percent: '-112.0', likelihood: -5 }],
};

// A gameState with its own players Map, so painting price data in one test can
// never leak into another.
function stateWith(overrides = {}, { deadlines = DEADLINES } = {}) {
  const players = new Map();
  for (const [id, p] of baseState.players) players.set(id, { ...p });
  for (const [id, raw] of Object.entries(overrides)) {
    const player = players.get(Number(id));
    player.priceChange = raw === null ? null : normalizePriceChange(raw);
  }
  return { ...baseState, players, rules: { ...baseState.rules, priceChangeDeadlines: deadlines } };
}

const cardFor = (overrides, opts) =>
  transfersCard({ bundle, gameState: stateWith(overrides, opts), now: NOW });

const chips = (node) => queryAll(node, 'fpl-price-chip').map(textOf);
// The chip inside one transfer side, found by walking that side's subtree.
const chipOn = (node, dir) => {
  const side = queryAll(node, `is-${dir}`).find(n => (n.className || '').includes('fpl-tr-side'));
  assert.ok(side, `the ${dir} side must render`);
  const chip = query(side, 'fpl-price-chip');
  return chip ? { text: textOf(chip), className: chip.className, title: chip.attributes.get('title') } : null;
};

/* ------------------------------------------------------------ the badges */

test('an incoming player projected to rise is badged, and marked urgent', () => {
  // SPEC: waiting costs the manager real money, which is the one case the
  // transfer card is allowed to shout about.
  const chip = chipOn(cardFor({ [pair.in]: RISE_TONIGHT }), 'in');
  assert.equal(chip.text, '↑ Rise tonight');
  assert.match(chip.className, /is-rise/);
  assert.match(chip.className, /is-urgent/);
});

test('an incoming player projected to fall is badged, but never urgent', () => {
  // SPEC: waiting might SAVE money here. Worth knowing, not worth shouting.
  const chip = chipOn(cardFor({ [pair.in]: FALL_TONIGHT }), 'in');
  assert.equal(chip.text, '↓ Fall tonight');
  assert.match(chip.className, /is-fall/);
  assert.doesNotMatch(chip.className, /is-urgent/);
});

test('an outgoing player projected to fall is badged, and marked urgent', () => {
  // SPEC: the mirror of the incoming rise. Holding loses team value.
  const chip = chipOn(cardFor({ [pair.out]: FALL_TONIGHT }), 'out');
  assert.equal(chip.text, '↓ Fall tonight');
  assert.match(chip.className, /is-urgent/);
});

test('an outgoing player projected to rise is badged, but never urgent', () => {
  const chip = chipOn(cardFor({ [pair.out]: RISE_TONIGHT }), 'out');
  assert.equal(chip.text, '↑ Rise tonight');
  assert.doesNotMatch(chip.className, /is-urgent/);
});

test('tomorrow and two days out are worded as themselves, not as tonight', () => {
  const tomorrow = chipOn(cardFor({
    [pair.in]: { price_change_projections: [
      { offset: 0, projected_percent: '80.0', likelihood: 3 },
      { offset: 1, projected_percent: '120.0', likelihood: 5 },
    ] },
  }), 'in');
  assert.equal(tomorrow.text, '↑ Rise tomorrow');

  const twoDays = chipOn(cardFor({
    [pair.in]: { price_change_projections: [
      { offset: 0, projected_percent: '40.0', likelihood: 1 },
      { offset: 1, projected_percent: '70.0', likelihood: 1 },
      { offset: 2, projected_percent: '105.0', likelihood: 3 },
    ] },
  }), 'in');
  assert.equal(twoDays.text, '↑ Rise in 2 days');
});

/* -------------------------------------------------------- the quiet cases */

test('a locked player never claims a move the game forbids', () => {
  // SPEC: the single most important assertion in this file. FPL has locked the
  // price, so a projection that crosses cannot happen, and the card must say
  // "locked" rather than "rise tonight".
  const chip = chipOn(cardFor({
    [pair.in]: { ...RISE_TONIGHT, price_change_locked_until: '2026-09-12T14:30:00Z' },
  }), 'in');
  assert.equal(chip.text, 'Price locked');
  assert.doesNotMatch(chip.text, /tonight|Rise|Fall/);
  assert.doesNotMatch(chip.className, /is-urgent/);
  assert.match(chip.title, /cannot change/);
});

test('a calibrating prediction is hedged and never urgent', () => {
  const chip = chipOn(cardFor({
    [pair.in]: { ...RISE_TONIGHT, price_change_calibrating: true },
  }), 'in');
  assert.equal(chip.text, '↑ Rise tonight?', 'the question mark is the hedge');
  assert.match(chip.className, /is-calibrating/);
  assert.doesNotMatch(chip.className, /is-urgent/);
  assert.match(chip.title, /still calibrating/);
});

test('a player drifting in the middle gets no chip at all', () => {
  // SPEC: a badge on every player is a badge on none of them.
  const card = cardFor({
    [pair.in]: { price_change_percent: '11.0', price_change_projections: [
      { offset: 0, projected_percent: '13.0', likelihood: 1 },
      { offset: 1, projected_percent: '19.0', likelihood: 1 },
    ] },
  });
  assert.deepEqual(chips(card), []);
});

test('with no price data the transfer card is byte-for-byte what it was before', () => {
  // SPEC: the regression guard for every payload without the fields. The sample
  // data has none, so this is the shipped card.
  const card = transfersCard({ bundle, gameState: baseState, now: NOW });
  assert.deepEqual(chips(card), []);
  const text = textOf(card);
  assert.doesNotMatch(text, /Rise|Fall|Price locked|Calibrating/);
  // The card still says everything it used to.
  assert.match(text, /Price/);
  assert.match(text, /Bank after/);
});

test('with no official deadlines the chip still renders without inventing a time', () => {
  const chip = chipOn(cardFor({ [pair.in]: RISE_TONIGHT }, { deadlines: [] }), 'in');
  assert.equal(chip.text, '↑ Rise tonight');
  assert.doesNotMatch(chip.title, /23:00/, 'no assumed hour ever reaches the tooltip');
});

test('the chip carries an accessible label that does not read as an arrow', () => {
  const chip = chipOn(cardFor({ [pair.in]: RISE_TONIGHT }), 'in');
  const side = queryAll(cardFor({ [pair.in]: RISE_TONIGHT }), 'fpl-price-chip')[0];
  const label = side.attributes.get('aria-label');
  assert.ok(label && label.length > 10, 'a sentence, not a symbol');
  assert.doesNotMatch(label, /↑|↓/);
  assert.match(label, /Fantasy Premier League projects a rise/);
  assert.equal(label, chip.title, 'the tooltip and the accessible name say the same thing');
});

/* ------------------------------------------------------------- the drawer */

test('the drawer breaks the prediction out into the three published windows', () => {
  const state = stateWith({ [pair.in]: {
    price_change_percent: '84.0',
    price_change_projections: [
      { offset: 0, projected_percent: '112.0', likelihood: 5 },
      { offset: 1, projected_percent: '139.0', likelihood: 3 },
      { offset: 2, projected_percent: '166.0', likelihood: 1 },
    ],
  } });
  const body = drawerBodyForTest({
    playerId: pair.in, gameState: state, projections: bundle.projections, gw, horizon: 3, now: NOW,
  });
  const text = textOf(body);
  assert.match(text, /Price change/);
  assert.match(text, /Current progress/);
  assert.match(text, /\+84%/, 'progress is signed, because the sign is the direction');
  assert.match(text, /\+112%/);
  assert.match(text, /Strong signal/);
  assert.match(text, /Moderate signal/);
  assert.match(text, /Slight signal/);
  // The horizon disclaimer, so nobody reads three days as five gameweeks.
  assert.match(text, /three days ahead and no further/);
});

test('the drawer never renders likelihood as a probability', () => {
  // SPEC: `likelihood` is an ordinal tier. "100% likely" would be the app
  // inventing a number Fantasy Premier League never published.
  const state = stateWith({ [pair.in]: RISE_TONIGHT });
  const text = textOf(drawerBodyForTest({
    playerId: pair.in, gameState: state, projections: bundle.projections, gw, horizon: 3, now: NOW,
  }));
  assert.doesNotMatch(text, /likelihood/i);
  assert.doesNotMatch(text, /\b\d+%\s*(likely|chance|probability)/i);
});

test('the drawer states a lock in words', () => {
  const state = stateWith({ [pair.in]: { ...RISE_TONIGHT, price_change_locked_until: '2026-09-12T14:30:00Z' } });
  const text = textOf(drawerBodyForTest({
    playerId: pair.in, gameState: state, projections: bundle.projections, gw, horizon: 3, now: NOW,
  }));
  assert.match(text, /Price locked until/);
  assert.match(text, /cannot change before then/);
});

test('the drawer states a calibrating prediction and withholds the tier', () => {
  const state = stateWith({ [pair.in]: { ...RISE_TONIGHT, price_change_calibrating: true } });
  const text = textOf(drawerBodyForTest({
    playerId: pair.in, gameState: state, projections: bundle.projections, gw, horizon: 3, now: NOW,
  }));
  assert.match(text, /still calibrating/);
  assert.match(text, /Calibrating/);
  assert.doesNotMatch(text, /Strong signal|Moderate signal|Slight signal/);
});

test('the drawer hides the whole section when the API gives nothing', () => {
  // SPEC: graceful absence, not an empty panel with dashes in it.
  const text = textOf(drawerBodyForTest({
    playerId: pair.in, gameState: baseState, projections: bundle.projections, gw, horizon: 3, now: NOW,
  }));
  assert.doesNotMatch(text, /Price change/);
  assert.doesNotMatch(text, /Current progress/);
});

/* ------------------------------------------------------- the demo dataset */

test('the shipped sample data carries price predictions, so ?demo=1 shows the feature', () => {
  // SPEC: the demo is the only way to see this app in-season without a team id.
  // Shipping the feature with a sample payload that predates the fields would
  // make it invisible to every visitor who is not mid-season with an FPL team.
  const withData = [...sampleState.players.values()].filter(p => p.priceChange);
  assert.equal(withData.length, sampleState.players.size, 'every sample player carries a prediction');
  assert.equal(sampleState.rules.priceChangeDeadlines.length, 3, 'and the three official windows');
});

test('the sample data exercises every state the UI can render', () => {
  // A demo that only ever shows "rise tonight" would leave the locked and
  // calibrating paths unseen until they appeared in production.
  const models = [...sampleState.players.values()]
    .map(p => readPriceChange(p, {
      now: Date.parse('2026-11-27T21:00:00Z'),
      deadlines: sampleState.rules.priceChangeDeadlines,
    }));
  const seen = new Set(models.filter(m => m.displayable).map(m => {
    if (m.direction === 'none') return 'locked';
    if (m.calibrating) return 'calibrating';
    return `${m.direction}-${m.timing}`;
  }));
  for (const state of ['rise-tonight', 'fall-tonight', 'rise-tomorrow', 'locked', 'calibrating']) {
    assert.ok(seen.has(state), `sample data must produce a ${state} player; saw ${[...seen].join(', ')}`);
  }
  // And most players must stay quiet, or the demo teaches the wrong lesson
  // about how often prices actually move.
  const quiet = models.filter(m => !m.displayable).length;
  assert.ok(quiet / models.length > 0.4, `only ${quiet}/${models.length} players are quiet`);
});

/* --------------------------------------------------------------- the copy */

test('the future-plan copy no longer claims prices never change', () => {
  // SPEC: the sentence used to say "and no price changes" flatly. That is now
  // false for the next three days and still true after them, and the copy has
  // to carry both halves without implying a five-gameweek price forecast.
  const card = transfersCard({ bundle, gameState: baseState, now: NOW });
  assert.ok(card, 'sanity');
  const source = readFileSync(join(APP, 'js', 'ui', 'dashboard.js'), 'utf8');
  const sentence = /These are projections, not instructions\.[^']*/.exec(source);
  assert.ok(sentence, 'the projections disclaimer must still exist');
  assert.doesNotMatch(sentence[0], /and no price changes,/, 'the flat claim is gone');
  assert.match(sentence[0], /three days ahead/, 'it states the real horizon');
  assert.match(sentence[0], /prices are assumed unchanged/, 'and that later prices are still assumed flat');
});
