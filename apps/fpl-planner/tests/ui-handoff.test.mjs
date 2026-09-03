// The handoff: what the planner hands to the bookmarklet, and the block that
// hands it over.
//
// The bookmarklet's own half of this contract is tested in bookmarklet.test.mjs
// against the shipped javascript: URL. This file owns the planner's half: which
// plans produce a payload at all, and what the user sees when one does.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, query, queryAll, textOf, click, fire, buttonWith } from './helpers/mini-dom.mjs';

const teardownDom = installDom();
after(() => teardownDom());

const {
  buildHandoff, encodeHandoff, decodeHandoff, chipRouting, benchOrder, PAYLOAD_VERSION,
} = await import('../js/ui/handoff.js');
const {
  handoffAction, handoffDialogContent, applyActionLabel, applySummaryText, BOOKMARKLET_NAME,
} = await import('../js/ui/handoff-view.js');
const { BOOKMARKLET_URL } = await import('../js/ui/bookmarklet-url.js');

// The squad the plan settles on: 203 has arrived in place of 108, which is what
// the transfer below says. The two halves of a payload have to agree, and this
// fixture is the shape of a plan that does.
const XI = [101, 103, 104, 105, 203, 109, 110, 111, 113, 114, 115];
const BENCH = { gk: 102, order: [106, 107, 112] };

const planWith = (over = {}) => ({
  gw: 5,
  chip: null,
  transferCount: 1,
  transfersOut: [108],
  transfersIn: [203],
  startingXI: XI.slice(),
  bench: { gk: BENCH.gk, order: BENCH.order.slice() },
  captain: 113,
  viceCaptain: 114,
  ...over,
});

// The same plan with the transfer taken back out: a roll, which is the majority
// of gameweeks and which still has an eleven to set.
const rollingPlan = (over = {}) => planWith({
  transferCount: 0,
  transfersOut: [],
  transfersIn: [],
  startingXI: XI.map(id => (id === 203 ? 108 : id)),
  ...over,
});

/* ------------------------------------------------------------ buildHandoff */

test('a plan becomes a payload the decoder accepts, transfers and team both', () => {
  const built = buildHandoff({ plan: planWith(), teamId: '4231987' });
  assert.equal(built.ok, true, built.reason);
  assert.deepEqual(built.payload, {
    v: PAYLOAD_VERSION,
    entry: 4231987,
    event: 5,
    chip: null,
    transfers: [{ out: 108, in: 203 }],
    team: {
      xi: XI,
      bench: [102, 106, 107, 112],
      captain: 113,
      vice: 114,
      chip: null,
    },
  });
  assert.equal(decodeHandoff(encodeHandoff(built.payload)).ok, true);
});

test('the bench travels keeper first, in the order the engine wants them on', () => {
  assert.deepEqual(benchOrder(planWith()), [102, 106, 107, 112]);
  assert.deepEqual(benchOrder({ bench: { gk: null, order: [1, 2, 3] } }), [1, 2, 3]);
  assert.deepEqual(benchOrder({}), []);
});

test('the payload carries ids, a gameweek and chips, and no money or positions', () => {
  // Prices this app reconstructed would arrive at FPL as an instruction, and
  // FPL's own numbers are the ones that bind. README, "selling prices". The
  // same goes for squad slots, which the bookmarklet derives from FPL's own
  // element types.
  const built = buildHandoff({ plan: planWith(), teamId: '7' });
  const text = encodeHandoff(built.payload);
  assert.equal(Object.keys(built.payload).sort().join(','), 'chip,entry,event,team,transfers,v');
  assert.equal(Object.keys(built.payload.team).sort().join(','), 'bench,captain,chip,vice,xi');
  assert.ok(!/price|bank|cost|value|position/i.test(text), `payload leaked a field it must not carry: ${text}`);
});

test('a team id that is not a team id is refused', () => {
  for (const teamId of [null, undefined, '', 'abc', '0', '-3', '1.5', {}]) {
    const built = buildHandoff({ plan: planWith(), teamId });
    assert.equal(built.ok, false, `accepted ${JSON.stringify(teamId)}`);
    assert.match(built.reason, /team ID/);
  }
});

// The reason the payload grew: a plan with no transfers is still a plan, and it
// is the plan in most gameweeks of a season.
test('a plan that makes no transfers still hands over its team', () => {
  const built = buildHandoff({ plan: rollingPlan(), teamId: '7' });
  assert.equal(built.ok, true, built.reason);
  assert.deepEqual(built.payload.transfers, []);
  assert.equal(built.payload.team.captain, 113);
  assert.equal(decodeHandoff(encodeHandoff(built.payload)).ok, true);
});

test('a plan with no team to set is refused', () => {
  for (const plan of [
    planWith({ startingXI: XI.slice(0, 10) }),
    planWith({ startingXI: undefined }),
    planWith({ bench: { gk: 102, order: [106] } }),
    planWith({ bench: undefined }),
  ]) {
    const built = buildHandoff({ plan, teamId: '7' });
    assert.equal(built.ok, false);
    assert.match(built.reason, /full eleven and bench/);
  }
  assert.equal(buildHandoff({ plan: null, teamId: '7' }).ok, false);
  assert.equal(buildHandoff({ plan: planWith({ gw: null }), teamId: '7' }).ok, false);
  assert.equal(buildHandoff({ plan: planWith({ transfersIn: [] }), teamId: '7' }).ok, false);
});

test('a pre-season draft is refused, because there is no squad on FPL yet', () => {
  const built = buildHandoff({ plan: planWith(), teamId: '7', isDraft: true });
  assert.equal(built.ok, false);
  assert.match(built.reason, /pre-season draft/);
});

test('an armband on a substitute is refused rather than wasted', () => {
  const built = buildHandoff({ plan: planWith({ captain: 106 }), teamId: '7' });
  assert.equal(built.ok, false);
  assert.match(built.reason, /captain or vice-captain on the bench/);
  assert.equal(buildHandoff({ plan: planWith({ viceCaptain: 113 }), teamId: '7' }).ok, false,
    'the same player cannot hold both armbands');
});

test('the two halves of a payload have to describe one squad', () => {
  // A fifteen that does not contain the player it just bought is a payload
  // arguing with itself, and it is exactly what a hand-edit produces.
  const orphan = buildHandoff({ plan: planWith({ transfersIn: [999] }), teamId: '7' });
  assert.equal(orphan.ok, false);
  assert.match(orphan.reason, /leaves out of the fifteen/);

  const kept = buildHandoff({ plan: planWith({ transfersOut: [113] }), teamId: '7' });
  assert.equal(kept.ok, false);
  assert.match(kept.reason, /keeps in the fifteen/);
});

test('each chip travels on the endpoint that plays it, and no other', () => {
  assert.deepEqual(chipRouting(null), { transfers: null, team: null, deferred: null });
  assert.deepEqual(chipRouting('wildcard'), { transfers: 'wildcard', team: null, deferred: null });
  assert.deepEqual(chipRouting('freehit'), { transfers: 'freehit', team: null, deferred: null });
  // Bench boost and triple captain are played by saving the team, so they ride
  // in the team half. An unknown chip is one this code has never been tested
  // against, and it is sent nowhere at all.
  assert.deepEqual(chipRouting('bboost'), { transfers: null, team: 'bboost', deferred: null });
  assert.deepEqual(chipRouting('3xc'), { transfers: null, team: '3xc', deferred: null });
  assert.deepEqual(chipRouting('megaboost'), { transfers: null, team: null, deferred: 'megaboost' });

  const wild = buildHandoff({ plan: planWith({ chip: 'wildcard' }), teamId: '7' });
  assert.equal(wild.payload.chip, 'wildcard');
  assert.equal(wild.payload.team.chip, null);
  assert.equal(wild.deferredChip, null);

  const boost = buildHandoff({ plan: planWith({ chip: 'bboost' }), teamId: '7' });
  assert.equal(boost.payload.chip, null, 'a bench boost must not be sent to the transfers endpoint');
  assert.equal(boost.payload.team.chip, 'bboost');
  assert.equal(boost.deferredChip, null);

  const unknown = buildHandoff({ plan: planWith({ chip: 'megaboost' }), teamId: '7' });
  assert.equal(unknown.payload.chip, null);
  assert.equal(unknown.payload.team.chip, null);
  assert.equal(unknown.deferredChip, 'megaboost');
});

/* --------------------------------------------------------- the hero button */

test('the button names the act, and the sentence under it names every part', () => {
  assert.equal(applyActionLabel(), 'Apply this plan on FPL');
  assert.equal(
    applySummaryText(planWith({ transferCount: 1 })),
    'Makes 1 transfer, then sets your XI, bench order, captain and vice-captain.'
  );
  assert.equal(
    applySummaryText(planWith({ transferCount: 2 })),
    'Makes 2 transfers, then sets your XI, bench order, captain and vice-captain.'
  );
  assert.equal(
    applySummaryText(rollingPlan()),
    'Sets your XI, bench order, captain and vice-captain.'
  );
  assert.match(applySummaryText(planWith({ chip: 'bboost' })), /and plays your Bench Boost\.$/);
  assert.match(applySummaryText(planWith({ chip: 'wildcard' })), /and plays your Wildcard\.$/);
  assert.doesNotMatch(applySummaryText(planWith({ chip: 'megaboost' })), /plays your/,
    'a chip this contract cannot carry must not be promised on the button');
});

const action = (over = {}) => handoffAction({
  plan: planWith(),
  teamId: '4231987',
  sample: false,
  onOpen: () => {},
  ...over,
});

test('nothing is offered when there is nothing to hand over', () => {
  assert.equal(action({ sample: true }), null, 'the sample team id belongs to nobody');
  assert.equal(action({ teamId: null }), null);
  assert.equal(action({ isDraft: true }), null);
  assert.equal(action({ plan: null }), null);
});

test('a roll is still offered, because its eleven still has to be set', () => {
  const node = action({ plan: rollingPlan() });
  assert.ok(node);
  assert.match(textOf(node), /Sets your XI, bench order, captain and vice-captain/);
});

test('the action is a primary button, not a disclosure to open', async () => {
  // It shipped as a collapsed <details> and read as more context rather than
  // as the thing to press. The class is the promise that it is a button.
  let opened = 0;
  const node = action({ onOpen: () => { opened += 1; } });
  const button = buttonWith(node, 'Apply this plan on FPL');
  assert.match(button.className, /fpl-btn-primary/);
  await click(button);
  assert.equal(opened, 1);
});

/* --------------------------------------------------------- the dialog body */

const content = (over = {}) => handoffDialogContent({
  plan: planWith(),
  teamId: '4231987',
  copyText: () => Promise.resolve(),
  ...over,
});

const wrap = (c) => {
  const box = document.createElement('div');
  for (const n of c.nodes) box.appendChild(n);
  return box;
};

test('a first-time user is shown the install step, and told what it is', () => {
  const box = wrap(content({ installedVersion: 0 }));
  assert.ok(query(box, 'is-install'), 'the install block is missing');
  assert.match(textOf(box), /First, install it \(once\)/);
  assert.match(textOf(box), /a bookmark, not an extension/);
  assert.match(textOf(box), /Then apply it/);
});

test('someone holding the current bookmarklet does not see the install step again', () => {
  const box = wrap(content({ installedVersion: PAYLOAD_VERSION }));
  assert.equal(query(box, 'is-install'), null, 'the install block should be gone');
  assert.match(textOf(box), /Apply it/);
  // But it stays reachable, because a new browser or a lost bookmark happens.
  assert.ok(buttonWith(box, 'Show the install step again'));
});

// The trap this closes: v1's install memory was a boolean, so a user who had
// installed the transfers-only bookmarklet would have been shown no install
// step and a payload their bookmarklet refuses.
test('someone holding an older bookmarklet is told to replace it', () => {
  const box = wrap(content({ installedVersion: PAYLOAD_VERSION - 1 }));
  assert.ok(query(box, 'is-install'), 'an out-of-date bookmarklet needs the install step back');
  assert.match(textOf(box), /First, replace your old bookmarklet/);
  assert.match(textOf(box), /only knows how to make transfers/);
});

test('asking for the install step back brings it back, and drops the ask', () => {
  const box = wrap(content({ installedVersion: PAYLOAD_VERSION, showInstall: true }));
  assert.ok(query(box, 'is-install'));
  assert.throws(() => buttonWith(box, 'Show the install step again'));
});

test('the plan on screen is exactly the plan that is copied', async () => {
  const copied = [];
  const c = content({ installedVersion: PAYLOAD_VERSION, copyText: (t) => { copied.push(t); return Promise.resolve(); } });
  const box = wrap(c);
  assert.equal(textOf(query(box, 'fpl-handoff-payload')), c.planText);
  assert.equal(decodeHandoff(c.planText).ok, true);

  await click(buttonWith(box, 'Copy the plan again'));
  assert.deepEqual(copied, [c.planText]);
  assert.match(textOf(c.copyStatus), /Copied again/);
});

test('a refused clipboard is reported, not swallowed', async () => {
  const c = content({ installedVersion: PAYLOAD_VERSION, copyText: () => Promise.reject(new Error('denied')) });
  const box = wrap(c);
  await click(buttonWith(box, 'Copy the plan again'));
  assert.match(textOf(c.copyStatus), /copy it yourself/);
  assert.match(c.copyStatus.className, /is-bad/);
});

test('dragging the bookmarklet counts as installing it', async () => {
  let installed = 0;
  const box = wrap(content({ installedVersion: 0, onInstalled: () => { installed += 1; } }));
  await fire(query(box, 'fpl-handoff-drag'), 'dragstart');
  assert.equal(installed, 1, 'a dragstart is the real signal that it went to the bookmarks bar');
});

test('copying the bookmarklet link also counts as installing it', async () => {
  let installed = 0;
  const copied = [];
  const box = wrap(content({
    installedVersion: 0,
    onInstalled: () => { installed += 1; },
    copyText: (t) => { copied.push(t); return Promise.resolve(); },
  }));
  await click(buttonWith(box, 'Copy the link instead'));
  assert.equal(copied.length, 1);
  assert.ok(copied[0].startsWith('javascript:'));
  assert.equal(copied[0], BOOKMARKLET_URL);
  assert.equal(installed, 1);
});

test('a failed bookmarklet copy does not claim it was installed', async () => {
  let installed = 0;
  const box = wrap(content({
    installedVersion: 0,
    onInstalled: () => { installed += 1; },
    copyText: () => Promise.reject(new Error('denied')),
  }));
  await click(buttonWith(box, 'Copy the link instead'));
  assert.equal(installed, 0);
  assert.match(textOf(box), /Right-click the link and copy its address/);
});

test('clicking the drag link explains itself instead of doing nothing', async () => {
  const box = wrap(content({ installedVersion: 0 }));
  const event = await click(query(box, 'fpl-handoff-drag'));
  // The site CSP blocks javascript: navigation, so an unhandled click is a
  // silent no-op and the user has no way to know they used it wrongly.
  assert.equal(event.defaultPrevented, true);
  assert.match(textOf(box), /for dragging, not clicking/);
  assert.equal(textOf(query(box, 'fpl-handoff-drag')), BOOKMARKLET_NAME);
});

test('the way out to Fantasy Premier League opens in a new tab, safely', () => {
  // The team page, not the transfers page: the bookmarklet now sets a team as
  // well, and that is the page a roll week needs.
  const link = query(wrap(content({ installedVersion: PAYLOAD_VERSION })), 'fpl-handoff-go');
  assert.equal(link.getAttribute('href'), 'https://fantasy.premierleague.com/my-team');
  assert.equal(link.getAttribute('target'), '_blank');
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
});

test('a chip this contract cannot carry is called out, and the two it can are not', () => {
  const unknown = wrap(content({ plan: planWith({ chip: 'megaboost' }) }));
  assert.match(textOf(query(unknown, 'fpl-handoff-warn')), /does not know how to play/);

  for (const chip of ['wildcard', 'freehit', 'bboost', '3xc']) {
    assert.equal(query(wrap(content({ plan: planWith({ chip }) })), 'fpl-handoff-warn'), null,
      `${chip} is applied by the bookmarklet, so there is nothing to warn about`);
  }
});

test('the dialog says what will be applied before it says how', () => {
  const box = wrap(content({ installedVersion: PAYLOAD_VERSION }));
  assert.match(textOf(box), /Makes 1 transfer, then sets your XI, bench order, captain and vice-captain\./);
  assert.match(textOf(box), /never asks for your password/);
});

test('the unofficial nature of the endpoints is stated where the user acts', () => {
  assert.match(
    textOf(wrap(content({ installedVersion: PAYLOAD_VERSION }))),
    /no supported way to make a transfer or set a team from outside their site/
  );
});

test('a dialog opened with nothing to hand over says so instead of half-rendering', () => {
  const c = content({ plan: planWith({ startingXI: [] }) });
  assert.equal(c.ok, false);
  assert.equal(c.planText, null);
  assert.match(textOf(wrap(c)), /Nothing to hand over/);
  assert.equal(queryAll(wrap(c), 'fpl-handoff-payload').length, 0);
});
