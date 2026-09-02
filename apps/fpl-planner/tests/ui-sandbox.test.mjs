// The sandbox view, rendered with the real modules under the repo's mini DOM.
//
// The browser drivers cover the in-season flow end to end. What lives here is
// what a headless browser cannot reach cheaply, plus the contract the 2026-08
// interaction rework introduced: the view is created ONCE and updated in
// place, so a selection click must not destroy the pitch it is selecting on.
// The original implementation re-rendered the whole app per click, which
// defeated scroll anchoring (hundreds of pixels of jump per click) and threw
// focus to <body>; the node-identity assertions here are the regression tests
// for that root cause.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom, query, queryAll, textOf, click, buttonWith } from './helpers/mini-dom.mjs';

// Teardown restores the real globals when the file ends, the same pattern as
// ui-combobox.test.mjs: an installDom() left in place leaks a fake `document`
// into any suite the runner loads after this one in the same process.
const teardownDom = installDom();
after(() => teardownDom());

const { assembleSampleBundle } = await import('../js/data/sample.js');
const { buildGameState } = await import('../js/engine/normalize.js');
const { buildSquadState } = await import('../js/engine/squad.js');
const { buildPlan } = await import('../js/engine/planner.js');
const { pitchCard } = await import('../js/ui/dashboard.js');
const { createSandboxView } = await import('../js/ui/sandbox.js');
const { createScenario, setCaptain, applyTransfer, isDirty, transferBlockedReason, swapPlayers, moveBench, comparison } = await import('../js/ui/scenario.js');

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

// A view plus the base props it renders from, so a test updates the SAME view
// the way app.js does rather than building a fresh tree per state.
function makeView(plan, squadState, { onAction = () => {}, onPlayerDetails = () => {}, origin } = {}) {
  const ctx = { gameState, squadState };
  const scenario = createScenario({
    squadState, gameState, plan: plan.current,
    origin: origin ?? (squadState.picks.length ? 'current' : 'recommended'),
  });
  const view = createSandboxView({ onAction, onPlayerDetails });
  const base = {
    scenario, ctx, projections: plan.projections, gw: plan.current.gw,
    horizon: 3, discount: 0.85, showXp: false, selection: null,
    picker: null, error: null, busy: false, scenarioBundle: null,
  };
  view.update(base);
  return { view, base, ctx, scenario };
}

const segLabels = (card) => {
  const tools = query(card, 'fpl-card-tools');
  const seg = tools ? query(tools, 'fpl-seg') : null;
  return seg ? seg.childNodes.filter(n => n.nodeType === 1).map(b => textOf(b).trim()) : [];
};

const sandboxOf = (view) => query(view.node, 'fpl-sandbox');

test('in season the card offers all three views of the squad', () => {
  const card = pitchCard({
    bundle: inSeasonPlan, gameState, initialMode: 'current', sandbox: () => makeView(inSeasonPlan, inSeasonSquad).view.node,
  });
  assert.deepEqual(segLabels(card), ['Current team', 'My scenario', 'Recommended']);
});

test('pre-season the card still offers the editable view, without a current team', () => {
  const card = pitchCard({
    bundle: draftPlan, gameState, initialMode: 'scenario', sandbox: () => makeView(draftPlan, draftSquad).view.node,
  });
  assert.deepEqual(segLabels(card), ['My scenario', 'Recommended']);
});

test('the remembered view survives a squad with no picks', () => {
  // The regression this pins: the selected view used to be derived from whether
  // the squad held picks, so a pre-season user was returned to "Recommended" on
  // every re-render, and since every scenario edit re-renders, the editable view
  // was unusable. The view is app state and must be honoured wherever it can be.
  const card = pitchCard({
    bundle: draftPlan, gameState, initialMode: 'scenario',
    sandbox: () => makeView(draftPlan, draftSquad).view.node,
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
    sandbox: () => makeView(draftPlan, draftSquad).view.node,
  });
  const on = query(query(card, 'fpl-card-tools'), 'fpl-seg')
    .childNodes.filter(n => n.nodeType === 1).find(b => (b.className || '').includes('is-on'));
  assert.equal(textOf(on).trim(), 'Recommended');
});

test('editing a pre-season build reads as edited and lists the changes', () => {
  // With no imported squad to diff against, "have I changed anything" has to be
  // answered against the fifteen this scenario was seeded from.
  const { view, base, ctx, scenario: sc } = makeView(draftPlan, draftSquad, { origin: 'recommended' });
  assert.equal(isDirty(sc, draftSquad), false);

  const outId = sc.xi[4];
  const inId = [...gameState.players.values()].find(p =>
    p.position === gameState.players.get(outId).position
    && !sc.squad.includes(p.id)
    && !transferBlockedReason(sc, ctx, outId, p.id)).id;
  const { scenario: edited, error } = applyTransfer(sc, ctx, outId, inId);
  assert.equal(error, null);
  assert.equal(isDirty(edited, draftSquad), true, 'a swapped player is an edit even before the season starts');

  view.update({ ...base, scenario: edited });
  const box = sandboxOf(view);
  assert.match(textOf(query(box, 'fpl-scenario-flag')), /edited scenario/i);
  const list = queryAll(box, 'fpl-moves');
  assert.equal(list.length, 1, 'the change is listed');
  // and it is NOT called a transfer, because before the deadline it is not one
  assert.doesNotMatch(textOf(box), /Transfers in this scenario/i);
  assert.match(textOf(box), /Changes to your opening fifteen/i);
});

test('with no sandbox supplied the card is exactly what it was before', () => {
  const card = pitchCard({ bundle: inSeasonPlan, gameState, initialMode: 'current' });
  assert.deepEqual(segLabels(card), ['Current team', 'Recommended']);
});

test('the pre-season sandbox renders the built fifteen and can be edited', () => {
  const { view } = makeView(draftPlan, draftSquad);
  const box = sandboxOf(view);
  const cards = queryAll(box, 'fpl-pp-edit');
  assert.equal(cards.length, 15, 'eleven and four');
  // It must not claim a transfer was made just because a squad exists.
  assert.equal(queryAll(box, 'fpl-moves').length, 0);
  const flag = query(box, 'fpl-scenario-flag');
  assert.match(textOf(flag), /nothing here is sent to Fantasy Premier League/i);
  // Before the first deadline the manager owns no squad, so this must not be
  // described as the team he has.
  assert.match(textOf(flag), /opening fifteen the planner built/i);
  assert.doesNotMatch(textOf(flag), /this is your team/i);
});

test('the editable pitch says which squad it is, every time it renders', () => {
  const { view, base, ctx, scenario: clean } = makeView(inSeasonPlan, inSeasonSquad);
  assert.match(textOf(query(view.node, 'fpl-scenario-flag')), /your team, ready to edit/i);

  const { scenario: edited } = setCaptain(clean, ctx, clean.xi.find(id => id !== clean.captain && id !== clean.viceCaptain));
  view.update({ ...base, scenario: edited });
  const flag = query(view.node, 'fpl-scenario-flag');
  assert.match(textOf(flag), /edited scenario/i);
  assert.match(textOf(flag), /not your FPL squad/i);
});

test('selecting a player offers actions, and the bench offers ordering', () => {
  const seen = [];
  const { view, base, scenario } = makeView(inSeasonPlan, inSeasonSquad, {
    onAction: (type, payload) => seen.push([type, payload]),
  });

  view.update({ ...base, selection: { playerId: scenario.xi[2], mode: 'menu' } });
  const starterActions = queryAll(query(view.node, 'fpl-actionbar'), 'fpl-btn').map(b => textOf(b).trim());
  assert.ok(starterActions.some(a => /Make captain/.test(a)));
  assert.ok(starterActions.some(a => /Transfer out/.test(a)));
  assert.ok(!starterActions.some(a => /bench/i.test(a) && /Move/.test(a)), 'a starter has no bench order');

  view.update({ ...base, selection: { playerId: scenario.benchOrder[1], mode: 'menu' } });
  const subActions = queryAll(query(view.node, 'fpl-actionbar'), 'fpl-btn').map(b => textOf(b).trim());
  assert.ok(subActions.some(a => /Move up the bench/.test(a)));
  assert.ok(subActions.some(a => /Swap into the eleven/.test(a)));

  // The armband is not offered to someone who cannot wear it.
  assert.ok(!subActions.some(a => /Make captain/.test(a)), 'a substitute is not offered the armband');

  // And the buttons actually dispatch.
  click(buttonWith(view.node, 'Move up the bench'));
  assert.deepEqual(seen[seen.length - 1][0], 'bench-up');
});

test('a selection click updates the existing cards instead of rebuilding the pitch', () => {
  // THE regression test for the flicker/jump root cause: a click that only
  // changes which player is selected must not destroy a single card node.
  // Destroyed nodes are what defeated scroll anchoring and dropped focus.
  const { view, base, scenario } = makeView(inSeasonPlan, inSeasonSquad);
  const before = queryAll(view.node, 'fpl-pp-edit');

  view.update({ ...base, selection: { playerId: scenario.xi[2], mode: 'menu' } });
  const after1 = queryAll(view.node, 'fpl-pp-edit');
  assert.equal(before.length, after1.length);
  for (let i = 0; i < before.length; i++) {
    assert.equal(before[i], after1[i], 'every card node survives a selection change by identity');
  }
  const selected = after1.filter(c => (c.className || '').includes('is-selected'));
  assert.equal(selected.length, 1, 'exactly one card is marked selected');
  assert.equal(selected[0].getAttribute('aria-pressed'), 'true');

  // Deselecting also touches classes only.
  view.update({ ...base, selection: null });
  const after2 = queryAll(view.node, 'fpl-pp-edit');
  assert.equal(after2.filter(c => (c.className || '').includes('is-selected')).length, 0);
  assert.equal(before[0], after2[0]);
});

test('an actual edit rebuilds the pitch, and only then', () => {
  const { view, base, ctx, scenario } = makeView(inSeasonPlan, inSeasonSquad);
  const before = queryAll(view.node, 'fpl-pp-edit');
  const { scenario: edited } = setCaptain(scenario, ctx, scenario.xi.find(id => id !== scenario.captain && id !== scenario.viceCaptain));
  view.update({ ...base, scenario: edited });
  const after = queryAll(view.node, 'fpl-pp-edit');
  assert.equal(after.length, before.length, 'still fifteen cards');
  assert.notEqual(before[0], after[0], 'the cards were rebuilt for the new squad state');
});

test('swap mode marks legal and blocked partners on the existing cards', () => {
  const { view, base, scenario } = makeView(inSeasonPlan, inSeasonSquad);
  const before = queryAll(view.node, 'fpl-pp-edit');
  view.update({ ...base, selection: { playerId: scenario.benchGk, mode: 'swap' } });
  const after = queryAll(view.node, 'fpl-pp-edit');
  assert.equal(before[0], after[0], 'entering swap mode does not rebuild the pitch either');

  const blocked = after.filter(c => (c.className || '').includes('is-target-blocked'));
  const legal = after.filter(c => (c.className || '').includes('is-target') && !(c.className || '').includes('is-target-blocked'));
  assert.ok(blocked.length > 0, 'an illegal partner is marked, not silently inert');
  assert.ok(legal.length > 0, 'the starting goalkeeper is a legal partner for the reserve');
  // The reason is pre-phrased for assistive tech; the visible sentence appears
  // in the dock when the card is actually pressed.
  assert.match(blocked[0].getAttribute('aria-label'), /cannot swap/i);
});

test('a refusal renders in the dock, in the validator\'s words', () => {
  const { view, base, scenario } = makeView(inSeasonPlan, inSeasonSquad);
  view.update({
    ...base,
    selection: { playerId: scenario.benchGk, mode: 'swap' },
    error: 'The reserve goalkeeper has his own slot and cannot change places with an outfield substitute.',
  });
  const msg = query(view.node, 'fpl-dock-msg');
  assert.ok(msg, 'the dock carries the refusal');
  assert.match(textOf(msg), /reserve goalkeeper/i);
  assert.ok((msg.className || '').includes('is-bad'));
});

test('the transfer picker takes the dock, and the dock reads as live', () => {
  const seen = [];
  const { view, base, scenario } = makeView(inSeasonPlan, inSeasonSquad, {
    onAction: (type, payload) => seen.push([type, payload]),
  });
  const picker = { outId: scenario.xi[3] };
  view.update({ ...base, picker });
  const dock = query(view.node, 'fpl-dock');
  assert.ok((dock.className || '').includes('is-live'), 'the dock pins while the picker is open');
  assert.ok(query(dock, 'fpl-picker'), 'the picker renders inside the dock');
  assert.match(textOf(query(dock, 'fpl-picker-head')), /Replace/);

  // The SAME picker object across updates keeps the same node, so typing in the
  // search box survives unrelated updates.
  const boxBefore = query(dock, 'fpl-picker');
  view.update({ ...base, picker, error: 'Some refusal.' });
  assert.equal(query(view.node, 'fpl-picker'), boxBefore, 'the open picker is not rebuilt by an unrelated update');

  // Closing it returns the hint and unpins.
  view.update({ ...base, picker: null });
  assert.ok(!(query(view.node, 'fpl-dock').className || '').includes('is-live'));
  assert.match(textOf(query(view.node, 'fpl-dock')), /Choose a player/i);
});

test('the toolbar reflects undo, reset and busy state in place', () => {
  const { view, base, ctx, scenario } = makeView(inSeasonPlan, inSeasonSquad);
  const undo = buttonWith(view.node, 'Undo');
  const reset = buttonWith(view.node, 'Reset to my team');
  assert.equal(undo.disabled, true, 'nothing to undo yet');
  assert.equal(reset.disabled, true, 'nothing to reset yet');

  const { scenario: edited } = setCaptain(scenario, ctx, scenario.xi.find(id => id !== scenario.captain && id !== scenario.viceCaptain));
  view.update({ ...base, scenario: edited });
  assert.equal(buttonWith(view.node, 'Undo'), undo, 'the toolbar buttons are stable nodes');
  assert.equal(undo.disabled, false);
  assert.equal(reset.disabled, false);

  view.update({ ...base, scenario: edited, busy: true });
  assert.equal(buttonWith(view.node, 'Asking the planner...').disabled, true);
  assert.match(textOf(query(view.node, 'fpl-scenario-busy')), /stays editable/i, 'the busy note does not replace the scenario');
  assert.equal(queryAll(view.node, 'fpl-pp-edit').length, 15, 'the pitch is untouched while the planner thinks');
});

test('the expected-points toggle adds detail and nothing else moves', () => {
  const { view, base } = makeView(inSeasonPlan, inSeasonSquad);
  assert.equal(queryAll(view.node, 'fpl-pp-detail').length, 0);
  view.update({ ...base, showXp: true });
  assert.equal(queryAll(view.node, 'fpl-pp-detail').length, 15);
  view.update({ ...base, showXp: false });
  assert.equal(queryAll(view.node, 'fpl-pp-detail').length, 0);
  assert.equal(queryAll(view.node, 'fpl-pp-edit').length, 15);
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

// ---------------------------------------------------------------------------
// The verdict line and the armband (added 2026-09-01)
// ---------------------------------------------------------------------------
//
// THE BUG THIS SECTION EXISTS FOR: the verdict judged an armband edit with
// `c.gw.delta`, which is expected points. The armband is not chosen on expected
// points - captain.js maximises a certainty equivalent that also weighs
// ceiling, fixture, duty, confidence and the vice - so moving the armband onto
// the higher-xP name was reported as "Your eleven projects +0.1 points this
// gameweek", in green. The app was congratulating a manager for overruling its
// own recommendation, measured with a ruler that recommendation never used.

const { captaincyScoreOf } = await import('../js/ui/scenario.js');

function verdictAfterCaptain(captainId) {
  const { view, base, ctx, scenario } = makeView(inSeasonPlan, inSeasonSquad);
  const moved = setCaptain(scenario, ctx, captainId).scenario;
  view.update({ ...base, scenario: moved });
  const node = query(view.node, 'fpl-verdict');
  return { text: node ? textOf(node).trim() : '', cls: node ? (node.className || '') : '' };
}

const scoreOf = (xi, id) => captaincyScoreOf(xi, id, { gameState, squadState: inSeasonSquad },
  { projections: inSeasonPlan.projections, gw: inSeasonPlan.current.gw });

test('an armband edit is judged on the captaincy score, not on expected points', () => {
  const { ctx, scenario } = makeView(inSeasonPlan, inSeasonSquad);
  const base = scenario.captain;
  const beaten = scenario.xi.find(id => id !== base
    && scoreOf(scenario.xi, id).eligible
    && scoreOf(scenario.xi, id).score < scoreOf(scenario.xi, base).score);
  assert.ok(beaten, 'the fixture must offer a captain the objective rates lower');

  const { text, cls } = verdictAfterCaptain(beaten);
  // The lead sentence is about the armband, and names the score it was judged on.
  assert.match(text, /Your armband gives up [\d.]+ on the captaincy score/);
  assert.doesNotMatch(text, /^Your eleven projects/, 'points must not lead an armband verdict');
  assert.match(cls, /is-down/);
  // The reported magnitude is never a rounded-away zero.
  assert.doesNotMatch(text, /gives up 0\.0 on/);
  // And the points effect is still stated, as the separate fact it is.
  assert.match(text, /This gameweek's expected points: [-+][\d.]+\./);
});

test('an armband edit the objective agrees with reads as a gain', () => {
  const { scenario } = makeView(inSeasonPlan, inSeasonSquad);
  const base = scenario.captain;
  const better = scenario.xi.find(id => id !== base
    && scoreOf(scenario.xi, id).eligible
    && scoreOf(scenario.xi, id).score > scoreOf(scenario.xi, base).score + 0.05);
  assert.ok(better, 'the fixture must offer a better armband than the one on file');

  const { text, cls } = verdictAfterCaptain(better);
  assert.match(text, /Your armband gains [\d.]+ on the captaincy score\./);
  assert.match(cls, /is-up/);
  assert.doesNotMatch(text, /gains 0\.0 on/);
});

test('captaining a player who probably will not appear is said plainly, not scored', () => {
  // His captainScore is mostly the value of his VICE playing instead of him, so
  // quoting it would understate the problem or even read as an upgrade. The
  // appearance probability is the thing that matters and it is what is said.
  const { scenario } = makeView(inSeasonPlan, inSeasonSquad);
  const sub = scenario.xi.find(id => !scoreOf(scenario.xi, id).eligible);
  assert.ok(sub, 'the sample eleven is expected to hold one sub-floor player');

  const { text, cls } = verdictAfterCaptain(sub);
  assert.match(text, /Your captain is only \d+% to appear, so the armband would most likely pass to your vice\./);
  assert.doesNotMatch(text, /captaincy score/, 'an incomparable score must not be quoted');
  assert.doesNotMatch(text, /level/, 'and a null delta must never surface as "level"');
  assert.match(cls, /is-down/);
});

test('the points verdict still leads when the armband did not move', () => {
  // The regression guard for the change above: an eleven edit that leaves the
  // armband alone is still judged in points, which is the right measure for it.
  const { view, base, ctx, scenario } = makeView(inSeasonPlan, inSeasonSquad);
  const posOf = id => (gameState.players.get(id) || {}).position;
  let out = null;
  let inn = null;
  for (const starter of scenario.xi) {
    if (starter === scenario.captain) continue;
    const match = scenario.benchOrder.find(b => posOf(b) === posOf(starter));
    if (match) { out = starter; inn = match; break; }
  }
  assert.ok(inn, 'the fixture must offer a same-position bench swap');

  const result = swapPlayers(scenario, ctx, out, inn);
  assert.equal(result.error, null, 'the swap must be legal for this test to mean anything');
  const swapped = result.scenario;
  view.update({ ...base, scenario: swapped });
  const node = query(view.node, 'fpl-verdict');
  const text = node ? textOf(node).trim() : '';

  assert.equal(swapped.captain, scenario.captain, 'this edit must not move the armband');
  assert.doesNotMatch(text, /captaincy score/);
  assert.match(text, /^Your eleven projects/);
});

test('the armband only leads when it is the ONLY thing that moved', () => {
  // THE REGRESSION THIS PINS, found verifying the deploy on live data.
  // "no transfer + the armband differs" is NOT the same as "only the armband
  // moved". app.js's "copy recommended" action seeds a scenario from the plan
  // while `comparison` still baselines against the manager's PICKS, so the
  // eleven and the armband both differ with zero transfers. Leading with the
  // armband there announced "your armband is level on the captaincy score" over
  // a three-point rearrangement of the eleven.
  // Reached here the way any user can: move the armband AND swap a bench player
  // into the eleven. Same fifteen, so no transfer; both the eleven and the
  // armband now differ from the picks this comparison baselines against.
  const { view, base, ctx, scenario } = makeView(inSeasonPlan, inSeasonSquad);
  const posOf = id => (gameState.players.get(id) || {}).position;
  let out = null; let inn = null;
  for (const starter of scenario.xi) {
    if (starter === scenario.captain) continue;
    const match = scenario.benchOrder.find(b => posOf(b) === posOf(starter));
    if (match) { out = starter; inn = match; break; }
  }
  assert.ok(inn, 'the fixture must offer a same-position bench swap');
  const newCaptain = scenario.xi.find(id => id !== scenario.captain && id !== out);
  const edited = swapPlayers(setCaptain(scenario, ctx, newCaptain).scenario, ctx, out, inn).scenario;
  const c = comparison(edited, ctx, { projections: inSeasonPlan.projections, gw: inSeasonPlan.current.gw, horizon: 3, discount: 0.85 });

  assert.equal(c.transfers, 0, 'the same fifteen, so no transfer');
  assert.equal(c.captainChanged, true, 'the armband differs');
  assert.equal(c.xiChanged, true, 'and so does the eleven - that is the whole point');

  view.update({ ...base, scenario: edited });
  const text = textOf(query(view.node, 'fpl-verdict')).trim();
  assert.match(text, /^Your eleven projects/, 'points must lead when the eleven also moved');
  assert.doesNotMatch(text, /^Your armband/);
  // The armband is still reported, as the footnote it is, and still says which way.
  assert.match(text, /The armband moved too/);
});

test('xiChanged is false when only the armband moved, and true when the eleven did', () => {
  const { ctx, scenario } = makeView(inSeasonPlan, inSeasonSquad);
  const opts = { projections: inSeasonPlan.projections, gw: inSeasonPlan.current.gw, horizon: 3, discount: 0.85 };

  const other = scenario.xi.find(id => id !== scenario.captain);
  const armbandOnly = setCaptain(scenario, ctx, other).scenario;
  assert.equal(comparison(armbandOnly, ctx, opts).xiChanged, false);

  const posOf = id => (gameState.players.get(id) || {}).position;
  let out = null; let inn = null;
  for (const starter of scenario.xi) {
    const match = scenario.benchOrder.find(b => posOf(b) === posOf(starter));
    if (match) { out = starter; inn = match; break; }
  }
  const swapped = swapPlayers(scenario, ctx, out, inn).scenario;
  assert.equal(comparison(swapped, ctx, opts).xiChanged, true);
});
