// The sandbox views, rendered with the real modules under the repo's mini DOM.
//
// The browser drivers cover the in-season flow end to end. What lives here is
// the part a headless browser cannot reach without a dataset that does not
// exist: the PRE-SEASON card, where there is no imported squad to switch to and
// the editable view has to be seeded from the opening 15 instead. Gating that
// switch on holding picks is what made the built fifteen uneditable, and only a
// rendered card shows it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom, query, queryAll, textOf, click, buttonWith } from './helpers/mini-dom.mjs';

installDom();

const { assembleSampleBundle } = await import('../js/data/sample.js');
const { buildGameState } = await import('../js/engine/normalize.js');
const { buildSquadState } = await import('../js/engine/squad.js');
const { buildPlan } = await import('../js/engine/planner.js');
const { pitchCard } = await import('../js/ui/dashboard.js');
const { renderSandbox } = await import('../js/ui/sandbox.js');
const { createScenario, setCaptain, applyTransfer, isDirty, transferBlockedReason } = await import('../js/ui/scenario.js');

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const sample = (name) => JSON.parse(readFileSync(join(APP, 'data', 'sample', `${name}.json`), 'utf8'));
const names = ['meta', 'bootstrap', 'fixtures', 'entry', 'entry-history', 'entry-transfers', 'entry-picks'];
const bundleFiles = assembleSampleBundle(Object.fromEntries(names.map(n => [n, sample(n)])));
const gameState = buildGameState(bundleFiles.bootstrap, bundleFiles.fixtures, { fetchedAt: bundleFiles.fetchedAt });
const gw = bundleFiles.planEvent;

const inSeasonSquad = buildSquadState({
  entry: bundleFiles.entry, history: bundleFiles.history, transfers: bundleFiles.transfers,
  picks: bundleFiles.picks, gameState, gw,
});
const draftSquad = buildSquadState({ entry: null, history: null, transfers: null, picks: null, gameState, gw });

const inSeasonPlan = await buildPlan({ gameState, squadState: inSeasonSquad, options: { horizon: 3 } });
const draftPlan = await buildPlan({ gameState, squadState: draftSquad, options: { horizon: 3 } });

const segLabels = (card) => {
  const tools = query(card, 'fpl-card-tools');
  const seg = tools ? query(tools, 'fpl-seg') : null;
  return seg ? seg.childNodes.filter(n => n.nodeType === 1).map(b => textOf(b).trim()) : [];
};

test('in season the card offers all three views of the squad', () => {
  const card = pitchCard({
    bundle: inSeasonPlan, gameState, initialMode: 'current', sandbox: () => renderSandboxFor(inSeasonPlan, inSeasonSquad),
  });
  assert.deepEqual(segLabels(card), ['Current team', 'My scenario', 'Recommended']);
});

test('pre-season the card still offers the editable view, without a current team', () => {
  // There are no picks before the first deadline, so "Current team" would be an
  // empty tab. The editable one has to survive that, seeded from the plan.
  assert.equal(draftSquad.picks.length, 0);
  const card = pitchCard({
    bundle: draftPlan, gameState, initialMode: 'current', sandbox: () => renderSandboxFor(draftPlan, draftSquad),
  });
  const labels = segLabels(card);
  assert.deepEqual(labels, ['My scenario', 'Recommended']);
  assert.equal(labels.includes('Current team'), false, 'nothing offers a squad that does not exist');
});

test('the remembered view survives a squad with no picks', () => {
  // The regression this pins: the selected view used to be derived from whether
  // the squad held picks, so a pre-season user was returned to "Recommended" on
  // every re-render, and since every scenario edit re-renders, the editable view
  // was unusable. The view is app state and must be honoured wherever it can be.
  const card = pitchCard({
    bundle: draftPlan, gameState, initialMode: 'scenario',
    sandbox: () => renderSandboxFor(draftPlan, draftSquad),
  });
  const on = query(query(card, 'fpl-card-tools'), 'fpl-seg')
    .childNodes.filter(n => n.nodeType === 1).find(b => (b.className || '').includes('is-on'));
  assert.equal(textOf(on).trim(), 'My scenario');
  assert.ok(queryAll(card, 'fpl-pp-edit').length === 15, 'and it renders the editable squad, not the read-only one');
});

test('a remembered view this squad cannot offer falls back instead of blanking', () => {
  // Pre-season there is no "Current team" to show.
  const card = pitchCard({
    bundle: draftPlan, gameState, initialMode: 'current',
    sandbox: () => renderSandboxFor(draftPlan, draftSquad),
  });
  const on = query(query(card, 'fpl-card-tools'), 'fpl-seg')
    .childNodes.filter(n => n.nodeType === 1).find(b => (b.className || '').includes('is-on'));
  assert.equal(textOf(on).trim(), 'Recommended');
});

test('editing a pre-season build reads as edited and lists the changes', () => {
  // With no imported squad to diff against, "have I changed anything" has to be
  // answered against the fifteen this scenario was seeded from.
  const ctx = { gameState, squadState: draftSquad };
  const sc = createScenario({ squadState: draftSquad, gameState, plan: draftPlan.current, origin: 'recommended' });
  assert.equal(isDirty(sc, draftSquad), false);

  const outId = sc.xi[4];
  const inId = [...gameState.players.values()].find(p =>
    p.position === gameState.players.get(outId).position
    && !sc.squad.includes(p.id)
    && !transferBlockedReason(sc, ctx, outId, p.id)).id;
  const { scenario: edited, error } = applyTransfer(sc, ctx, outId, inId);
  assert.equal(error, null);
  assert.equal(isDirty(edited, draftSquad), true, 'a swapped player is an edit even before the season starts');

  const node = renderSandbox({
    scenario: edited, ctx, projections: draftPlan.projections, gw: draftPlan.current.gw,
    horizon: 3, discount: 0.85, showXp: false, selection: null,
    onAction: () => {}, onPlayerDetails: () => {}, picker: null,
  });
  assert.match(textOf(query(node, 'fpl-scenario-flag')), /edited scenario/i);
  const list = queryAll(node, 'fpl-moves');
  assert.equal(list.length, 1, 'the change is listed');
  // and it is NOT called a transfer, because before the deadline it is not one
  assert.doesNotMatch(textOf(node), /Transfers in this scenario/i);
  assert.match(textOf(node), /Changes to your opening fifteen/i);
});

test('with no sandbox supplied the card is exactly what it was before', () => {
  const card = pitchCard({ bundle: inSeasonPlan, gameState, initialMode: 'current' });
  assert.deepEqual(segLabels(card), ['Current team', 'Recommended']);
});

function renderSandboxFor(plan, squadState) {
  const ctx = { gameState, squadState };
  const scenario = createScenario({
    squadState, gameState, plan: plan.current,
    origin: squadState.picks.length ? 'current' : 'recommended',
  });
  return renderSandbox({
    scenario, ctx, projections: plan.projections, gw: plan.current.gw,
    horizon: 3, discount: 0.85, showXp: false, selection: null,
    onAction: () => {}, onPlayerDetails: () => {}, picker: null,
  });
}

test('the pre-season sandbox renders the built fifteen and can be edited', () => {
  const node = renderSandboxFor(draftPlan, draftSquad);
  const cards = queryAll(node, 'fpl-pp-edit');
  assert.equal(cards.length, 15, 'eleven and four');
  // It must not claim a transfer was made just because a squad exists.
  assert.equal(queryAll(node, 'fpl-moves').length, 0);
  const flag = query(node, 'fpl-scenario-flag');
  assert.match(textOf(flag), /nothing here is sent to Fantasy Premier League/i);
  // Before the first deadline the manager owns no squad, so this must not be
  // described as the team he has.
  assert.match(textOf(flag), /opening fifteen the planner built/i);
  assert.doesNotMatch(textOf(flag), /this is your team/i);
});

test('the editable pitch says which squad it is, every time it renders', () => {
  const ctx = { gameState, squadState: inSeasonSquad };
  const clean = createScenario({ squadState: inSeasonSquad, gameState });
  const untouched = renderSandbox({
    scenario: clean, ctx, projections: inSeasonPlan.projections, gw,
    horizon: 3, discount: 0.85, showXp: false, selection: null,
    onAction: () => {}, onPlayerDetails: () => {}, picker: null,
  });
  assert.match(textOf(query(untouched, 'fpl-scenario-flag')), /your team, ready to edit/i);

  const { scenario: edited } = setCaptain(clean, ctx, clean.xi.find(id => id !== clean.captain && id !== clean.viceCaptain));
  const dirty = renderSandbox({
    scenario: edited, ctx, projections: inSeasonPlan.projections, gw,
    horizon: 3, discount: 0.85, showXp: false, selection: null,
    onAction: () => {}, onPlayerDetails: () => {}, picker: null,
  });
  assert.match(textOf(query(dirty, 'fpl-scenario-flag')), /edited scenario/i);
  assert.match(textOf(query(dirty, 'fpl-scenario-flag')), /not your FPL squad/i);
});

test('selecting a player offers actions, and the bench offers ordering', () => {
  const ctx = { gameState, squadState: inSeasonSquad };
  const scenario = createScenario({ squadState: inSeasonSquad, gameState });
  const seen = [];
  const withSelection = (playerId, mode) => renderSandbox({
    scenario, ctx, projections: inSeasonPlan.projections, gw, horizon: 3, discount: 0.85,
    showXp: false, selection: { playerId, mode },
    onAction: (type, payload) => seen.push([type, payload]), onPlayerDetails: () => {}, picker: null,
  });

  const starter = withSelection(scenario.xi[2], 'menu');
  const starterActions = queryAll(query(starter, 'fpl-actionbar'), 'fpl-btn').map(b => textOf(b).trim());
  assert.ok(starterActions.some(a => /Make captain/.test(a)));
  assert.ok(starterActions.some(a => /Transfer out/.test(a)));
  assert.ok(!starterActions.some(a => /bench/i.test(a) && /Move/.test(a)), 'a starter has no bench order');

  const subNode = withSelection(scenario.benchOrder[1], 'menu');
  const subActions = queryAll(query(subNode, 'fpl-actionbar'), 'fpl-btn').map(b => textOf(b).trim());
  assert.ok(subActions.some(a => /Move up the bench/.test(a)));
  assert.ok(subActions.some(a => /Swap into the eleven/.test(a)));

  // The armband is not offered to someone who cannot wear it.
  assert.ok(!subActions.some(a => /Make captain/.test(a)), 'a substitute is not offered the armband');

  // And the buttons actually dispatch.
  click(buttonWith(subNode, 'Move up the bench'));
  assert.deepEqual(seen[seen.length - 1][0], 'bench-up');
});

test('swap mode marks the players who cannot take the place, with the reason', () => {
  const ctx = { gameState, squadState: inSeasonSquad };
  const scenario = createScenario({ squadState: inSeasonSquad, gameState });
  const node = renderSandbox({
    scenario, ctx, projections: inSeasonPlan.projections, gw, horizon: 3, discount: 0.85,
    showXp: false, selection: { playerId: scenario.benchGk, mode: 'swap' },
    onAction: () => {}, onPlayerDetails: () => {}, picker: null,
  });
  const blocked = queryAll(node, 'fpl-pp-blocked');
  assert.ok(blocked.length > 0, 'an illegal partner is marked, not silently inert');
  assert.match(textOf(blocked[0]), /goalkeeper|eleven plays/i);
});

test('the expected-points toggle adds detail and nothing else moves', () => {
  const ctx = { gameState, squadState: inSeasonSquad };
  const scenario = createScenario({ squadState: inSeasonSquad, gameState });
  const base = { scenario, ctx, projections: inSeasonPlan.projections, gw, horizon: 3, discount: 0.85, selection: null, onAction: () => {}, onPlayerDetails: () => {}, picker: null };
  const off = renderSandbox({ ...base, showXp: false });
  const on = renderSandbox({ ...base, showXp: true });
  assert.equal(queryAll(off, 'fpl-pp-detail').length, 0);
  assert.equal(queryAll(on, 'fpl-pp-detail').length, 15);
  assert.equal(queryAll(off, 'fpl-pp-edit').length, queryAll(on, 'fpl-pp-edit').length);
});

/* ------------------------------------------------------------- chip card */

// The audit found the chips card asserting three things at once that could not
// all be true: "play your Wildcard" above a row reading "Wildcard: Hold", a
// chip listed as usable now AND not open until GW20, and "no chip clears its
// bar" on a pre-season screen where chips were never evaluated at all.

const { chipCard } = await import('../js/ui/dashboard.js');

test('a recommended chip does not read as "Hold" on its own row', () => {
  const bundle = {
    ...inSeasonPlan,
    current: { ...inSeasonPlan.current, chip: 'wildcard', gw: inSeasonPlan.current.gw,
      explanation: { ...inSeasonPlan.current.explanation,
        chipReason: {
          reasons: [{ text: 'A full rebuild projects 16.4 more points.' }],
          perChip: {
            wildcard: { chip: 'wildcard', available: true, recommended: true, bestGw: null },
            freehit: { chip: 'freehit', available: true, recommended: false, bestGw: inSeasonPlan.current.gw + 3 },
            bboost: { chip: 'bboost', available: false, recommended: false, bestGw: null },
            '3xc': { chip: '3xc', available: true, recommended: false, bestGw: null },
          },
        } } },
  };
  const text = textOf(chipCard({ bundle, gameState }));
  assert.match(text, /Play your Wildcard this gameweek/);
  assert.match(text, /Playing it this gameweek/, 'the wildcard row agrees with the headline');
  assert.doesNotMatch(text, /Wildcard\s*Hold/, 'and never contradicts it');
  assert.match(text, /Best around GW/, 'a chip with a better week still says so');
  assert.match(text, /Used or out of window/);
});

test('a chip that clears its bar but is not the plan says so plainly', () => {
  const gw = inSeasonPlan.current.gw;
  const bundle = {
    ...inSeasonPlan,
    current: { ...inSeasonPlan.current, chip: null,
      explanation: { ...inSeasonPlan.current.explanation,
        chipReason: { reasons: [], perChip: {
          '3xc': { chip: '3xc', available: true, recommended: true, bestGw: gw },
        } } } },
  };
  const text = textOf(chipCard({ bundle, gameState }));
  assert.match(text, /Clears its bar this gameweek/);
  assert.doesNotMatch(text, /Triple Captain\s*Hold/);
});

test('pre-season the card does not claim a verdict the engine never computed', () => {
  // planner.js does not evaluate chips for a draft squad, so there is no
  // measurement to report and the card must not invent one.
  assert.equal(draftPlan.chipEvaluation, null, 'the engine really does skip this');
  const text = textOf(chipCard({ bundle: draftPlan, gameState }));
  assert.match(text, /judged once you have a squad/i);
  assert.doesNotMatch(text, /clears its bar/i, 'no bar was measured');
  assert.doesNotMatch(text, /Keep your chips for now/, 'and no verdict was reached');
});

test('a chip that exists in both halves is not listed as usable and unavailable at once', () => {
  const text = textOf(chipCard({ bundle: inSeasonPlan, gameState }));
  const later = text.match(/Not open yet(.*)$/s);
  if (later) {
    // Anything named as "not open yet" is named with the half it belongs to, so
    // it cannot be read as the same chip that is usable right now.
    assert.match(later[1], /(first half|second half|this season)/,
      'a not-yet-open chip says which half-season it is');
  }
});
