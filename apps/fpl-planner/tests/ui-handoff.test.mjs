// The handoff: what the planner hands to the transfer bookmarklet, and the
// block that hands it over.
//
// The bookmarklet's own half of this contract is tested in bookmarklet.test.mjs
// against the shipped javascript: URL. This file owns the planner's half: which
// plans produce a payload at all, and what the user sees when one does.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, query, queryAll, textOf, click, fire, buttonWith } from './helpers/mini-dom.mjs';

const teardownDom = installDom();
after(() => teardownDom());

const { buildHandoff, encodeHandoff, decodeHandoff, chipRouting } = await import('../js/ui/handoff.js');
const {
  handoffAction, handoffDialogContent, transferActionLabel, BOOKMARKLET_NAME,
} = await import('../js/ui/handoff-view.js');
const { BOOKMARKLET_URL } = await import('../js/ui/bookmarklet-url.js');

const planWith = (over = {}) => ({
  gw: 5,
  chip: null,
  transferCount: 1,
  transfersOut: [108],
  transfersIn: [203],
  ...over,
});

/* ------------------------------------------------------------ buildHandoff */

test('a plan with transfers becomes a payload the decoder accepts', () => {
  const built = buildHandoff({ plan: planWith({ transfersOut: [11, 12], transfersIn: [21, 22] }), teamId: '4231987' });
  assert.equal(built.ok, true);
  assert.deepEqual(built.payload, {
    v: 1,
    entry: 4231987,
    event: 5,
    chip: null,
    transfers: [{ out: 11, in: 21 }, { out: 12, in: 22 }],
  });
  assert.equal(decodeHandoff(encodeHandoff(built.payload)).ok, true);
});

test('the payload carries ids and a gameweek, and no money', () => {
  // Prices this app reconstructed would arrive at FPL as an instruction, and
  // FPL's own numbers are the ones that bind. README, "selling prices".
  const built = buildHandoff({ plan: planWith(), teamId: '7' });
  const text = encodeHandoff(built.payload);
  assert.equal(Object.keys(built.payload).sort().join(','), 'chip,entry,event,transfers,v');
  assert.ok(!/price|bank|cost|value/i.test(text), `payload leaked a money field: ${text}`);
});

test('a team id that is not a team id is refused', () => {
  for (const teamId of [null, undefined, '', 'abc', '0', '-3', '1.5', {}]) {
    const built = buildHandoff({ plan: planWith(), teamId });
    assert.equal(built.ok, false, `accepted ${JSON.stringify(teamId)}`);
    assert.match(built.reason, /team ID/);
  }
});

test('a plan that makes no transfers is refused', () => {
  for (const plan of [
    planWith({ transferCount: 0, transfersOut: [], transfersIn: [] }),
    planWith({ transfersOut: [1], transfersIn: [] }),
    planWith({ transfersOut: undefined, transfersIn: undefined }),
  ]) {
    const built = buildHandoff({ plan, teamId: '7' });
    assert.equal(built.ok, false);
    assert.match(built.reason, /no transfers|nothing to submit/);
  }
  assert.equal(buildHandoff({ plan: null, teamId: '7' }).ok, false);
  assert.equal(buildHandoff({ plan: planWith({ gw: null }), teamId: '7' }).ok, false);
});

test('only the two chips that ARE transfers travel with them', () => {
  assert.deepEqual(chipRouting(null), { submit: null, deferred: null });
  assert.deepEqual(chipRouting('wildcard'), { submit: 'wildcard', deferred: null });
  assert.deepEqual(chipRouting('freehit'), { submit: 'freehit', deferred: null });
  // Bench boost and triple captain are played on the team page, and an unknown
  // chip is one this code has never been tested against: neither is sent.
  assert.deepEqual(chipRouting('bboost'), { submit: null, deferred: 'bboost' });
  assert.deepEqual(chipRouting('3xc'), { submit: null, deferred: '3xc' });
  assert.deepEqual(chipRouting('megaboost'), { submit: null, deferred: 'megaboost' });

  const wild = buildHandoff({ plan: planWith({ chip: 'wildcard' }), teamId: '7' });
  assert.equal(wild.payload.chip, 'wildcard');
  assert.equal(wild.deferredChip, null);

  const boost = buildHandoff({ plan: planWith({ chip: 'bboost' }), teamId: '7' });
  assert.equal(boost.payload.chip, null, 'a bench boost must not be sent to the transfers endpoint');
  assert.equal(boost.deferredChip, 'bboost');
});

/* ------------------------------------------------------- the card's button */

test('the button names the act, with the count already in it', () => {
  assert.equal(transferActionLabel(planWith({ transferCount: 1 })), 'Make this transfer on FPL');
  assert.equal(transferActionLabel(planWith({ transferCount: 2 })), 'Make these 2 transfers on FPL');
  assert.equal(transferActionLabel(planWith({ transferCount: 3 })), 'Make these 3 transfers on FPL');
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
  assert.equal(action({ plan: planWith({ transferCount: 0, transfersOut: [], transfersIn: [] }) }), null);
  assert.equal(action({ plan: null }), null);
});

test('the action is a primary button, not a disclosure to open', async () => {
  // It shipped as a collapsed <details> and read as more context rather than
  // as the thing to press. The class is the promise that it is a button.
  let opened = 0;
  const node = action({ onOpen: () => { opened += 1; } });
  const button = buttonWith(node, 'Make this transfer on FPL');
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
  const box = wrap(content({ installed: false }));
  assert.ok(query(box, 'is-install'), 'the install block is missing');
  assert.match(textOf(box), /First, install it \(once\)/);
  assert.match(textOf(box), /a bookmark, not an extension/);
  assert.match(textOf(box), /Then apply it/);
});

test('someone who has installed it does not see the install step again', () => {
  const box = wrap(content({ installed: true }));
  assert.equal(query(box, 'is-install'), null, 'the install block should be gone');
  assert.match(textOf(box), /Apply it/);
  // But it stays reachable, because a new browser or a lost bookmark happens.
  assert.ok(buttonWith(box, 'Show the install step again'));
});

test('asking for the install step back brings it back, and drops the ask', () => {
  const box = wrap(content({ installed: true, showInstall: true }));
  assert.ok(query(box, 'is-install'));
  assert.throws(() => buttonWith(box, 'Show the install step again'));
});

test('the plan on screen is exactly the plan that is copied', async () => {
  const copied = [];
  const c = content({ installed: true, copyText: (t) => { copied.push(t); return Promise.resolve(); } });
  const box = wrap(c);
  assert.equal(textOf(query(box, 'fpl-handoff-payload')), c.planText);
  assert.equal(decodeHandoff(c.planText).ok, true);

  await click(buttonWith(box, 'Copy the plan again'));
  assert.deepEqual(copied, [c.planText]);
  assert.match(textOf(c.copyStatus), /Copied again/);
});

test('a refused clipboard is reported, not swallowed', async () => {
  const c = content({ installed: true, copyText: () => Promise.reject(new Error('denied')) });
  const box = wrap(c);
  await click(buttonWith(box, 'Copy the plan again'));
  assert.match(textOf(c.copyStatus), /copy it yourself/);
  assert.match(c.copyStatus.className, /is-bad/);
});

test('dragging the bookmarklet counts as installing it', async () => {
  let installed = 0;
  const box = wrap(content({ installed: false, onInstalled: () => { installed += 1; } }));
  await fire(query(box, 'fpl-handoff-drag'), 'dragstart');
  assert.equal(installed, 1, 'a dragstart is the real signal that it went to the bookmarks bar');
});

test('copying the bookmarklet link also counts as installing it', async () => {
  let installed = 0;
  const copied = [];
  const box = wrap(content({
    installed: false,
    onInstalled: () => { installed += 1; },
    copyText: (t) => { copied.push(t); return Promise.resolve(); },
  }));
  await click(buttonWith(box, 'Copy the link instead'));
  assert.equal(copied.length, 1);
  assert.ok(copied[0].startsWith('javascript:'));
  assert.equal(installed, 1);
});

test('a failed bookmarklet copy does not claim it was installed', async () => {
  let installed = 0;
  const box = wrap(content({
    installed: false,
    onInstalled: () => { installed += 1; },
    copyText: () => Promise.reject(new Error('denied')),
  }));
  await click(buttonWith(box, 'Copy the link instead'));
  assert.equal(installed, 0);
  assert.match(textOf(box), /Right-click the link and copy its address/);
});

test('clicking the drag link explains itself instead of doing nothing', async () => {
  const box = wrap(content({ installed: false }));
  const event = await click(query(box, 'fpl-handoff-drag'));
  // The site CSP blocks javascript: navigation, so an unhandled click is a
  // silent no-op and the user has no way to know they used it wrongly.
  assert.equal(event.defaultPrevented, true);
  assert.match(textOf(box), /for dragging, not clicking/);
});

test('the way out to Fantasy Premier League opens in a new tab, safely', () => {
  const link = query(wrap(content({ installed: true })), 'fpl-handoff-go');
  assert.equal(link.getAttribute('href'), 'https://fantasy.premierleague.com/transfers');
  assert.equal(link.getAttribute('target'), '_blank');
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
});

test('a chip that is not played by transferring is called out', () => {
  const boost = wrap(content({ plan: planWith({ chip: 'bboost' }) }));
  assert.match(textOf(query(boost, 'fpl-handoff-warn')), /played on your Fantasy Premier League team page/);

  const wild = wrap(content({ plan: planWith({ chip: 'wildcard' }) }));
  assert.equal(query(wild, 'fpl-handoff-warn'), null, 'a wildcard travels with the transfers, so there is nothing to defer');
});

test('the unofficial nature of the endpoint is stated where the user acts', () => {
  assert.match(textOf(wrap(content({ installed: true }))), /no supported way to make a transfer from outside their site/);
});

test('a dialog opened with nothing to hand over says so instead of half-rendering', () => {
  const c = content({ plan: planWith({ transferCount: 0, transfersOut: [], transfersIn: [] }) });
  assert.equal(c.ok, false);
  assert.equal(c.planText, null);
  assert.match(textOf(wrap(c)), /Nothing to hand over/);
});
