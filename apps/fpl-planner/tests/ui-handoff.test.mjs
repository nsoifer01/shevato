// The handoff: what the planner hands to the transfer bookmarklet, and the
// block that hands it over.
//
// The bookmarklet's own half of this contract is tested in bookmarklet.test.mjs
// against the shipped javascript: URL. This file owns the planner's half: which
// plans produce a payload at all, and what the user sees when one does.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, query, queryAll, textOf, click, buttonWith } from './helpers/mini-dom.mjs';

const teardownDom = installDom();
after(() => teardownDom());

const { buildHandoff, encodeHandoff, decodeHandoff, chipRouting } = await import('../js/ui/handoff.js');
const { handoffSection, BOOKMARKLET_NAME } = await import('../js/ui/handoff-view.js');
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

/* ---------------------------------------------------------- handoffSection */

const render = (over = {}) => handoffSection({
  plan: planWith(),
  teamId: '4231987',
  sample: false,
  copyText: () => Promise.resolve(),
  ...over,
});

test('nothing is offered when there is nothing to hand over', () => {
  assert.equal(render({ sample: true }), null, 'the sample team id belongs to nobody');
  assert.equal(render({ teamId: null }), null);
  assert.equal(render({ plan: planWith({ transferCount: 0, transfersOut: [], transfersIn: [] }) }), null);
  assert.equal(render({ plan: null }), null);
});

test('the three steps are all there, in order', () => {
  const node = render();
  const steps = queryAll(node, 'fpl-handoff-step-t').map(textOf);
  assert.deepEqual(steps, [
    'Install it once',
    'Copy this plan',
    'Apply it on Fantasy Premier League',
  ]);
  assert.match(textOf(node), /never asks for your password/);
});

test('the plan on screen is exactly the plan that is copied', () => {
  const node = render();
  const shown = textOf(query(node, 'fpl-handoff-payload'));
  const expected = encodeHandoff(buildHandoff({ plan: planWith(), teamId: '4231987' }).payload);
  assert.equal(shown, expected);
  // Shown rather than hidden behind the button: this is the text that will
  // spend the user's transfers, so it has to be readable before it is pasted.
  assert.equal(decodeHandoff(shown).ok, true);
});

test('Copy plan puts the payload on the clipboard and says so', async () => {
  const copied = [];
  const node = render({ copyText: (text) => { copied.push(text); return Promise.resolve(); } });
  await click(buttonWith(node, 'Copy plan'));
  assert.equal(copied.length, 1);
  assert.equal(decodeHandoff(copied[0]).ok, true);
  const status = queryAll(node, 'fpl-handoff-status').find(n => textOf(n));
  assert.match(textOf(status), /Copied/);
});

test('a refused clipboard is reported, not swallowed', async () => {
  const node = render({ copyText: () => Promise.reject(new Error('denied')) });
  await click(buttonWith(node, 'Copy plan'));
  const bad = queryAll(node, 'fpl-handoff-status').find(n => textOf(n));
  assert.match(textOf(bad), /copy it yourself/);
  assert.match(bad.className, /is-bad/);
});

test('the bookmarklet is offered as a draggable link and as copyable text', async () => {
  const copied = [];
  const node = render({ copyText: (text) => { copied.push(text); return Promise.resolve(); } });
  const link = query(node, 'fpl-handoff-drag');
  assert.equal(textOf(link), BOOKMARKLET_NAME);
  assert.equal(link.getAttribute('href'), BOOKMARKLET_URL);
  assert.ok(BOOKMARKLET_URL.startsWith('javascript:'));

  await click(buttonWith(node, 'Copy the link instead'));
  assert.deepEqual(copied, [BOOKMARKLET_URL]);
});

test('clicking the drag link explains itself instead of doing nothing', async () => {
  const node = render();
  const event = await click(query(node, 'fpl-handoff-drag'));
  // The site CSP blocks javascript: navigation, so an unhandled click is a
  // silent no-op and the user has no way to know they used it wrongly.
  assert.equal(event.defaultPrevented, true);
  assert.match(textOf(node), /for dragging, not clicking/);
});

test('a chip that is not played by transferring is called out', () => {
  const boost = render({ plan: planWith({ chip: 'bboost' }) });
  assert.match(textOf(query(boost, 'fpl-handoff-warn')), /played on your Fantasy Premier League team page/);

  const wild = render({ plan: planWith({ chip: 'wildcard' }) });
  assert.equal(query(wild, 'fpl-handoff-warn'), null, 'a wildcard travels with the transfers, so there is nothing to defer');
});

test('the unofficial nature of the endpoint is stated where the user acts', () => {
  assert.match(textOf(render()), /no supported way to make a transfer from outside their site/);
});
