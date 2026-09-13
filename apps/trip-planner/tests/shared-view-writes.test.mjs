// A shared link is read-only, and that includes the assistant (2026-09-12
// audit, T-4).
//
// In a shared view `db` holds a stranger's trip and save() refuses, so any
// control that edits the trip "works" on screen and is gone on reload. The
// toolbar hid the obvious ones, but the assistant stayed reachable - from the
// phone More menu, and through a handler that ran ask-day ahead of the shared
// guard - so "Add to trip" painted an item that existed nowhere and every
// message spent the site's shared Gemini quota on a trip the visitor cannot
// edit. The same More menu reached the whole-trip shift, and the visa checker
// (a fine thing to READ on someone's trip) still added countries and
// reminders. Importing the trip is the way to edit it, and after an import
// every one of these works again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { bootApp, makeStorage, target, LS_KEY } from './app-harness.mjs';

const { bytesToBase64url } = createRequire(import.meta.url)('../js/trip-logic.js');

const DAY = '2027-06-10';

async function shareHash(sharedTrip) {
  const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, trip: sharedTrip }));
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return '#share=' + bytesToBase64url(new Uint8Array(await new Response(stream).arrayBuffer()));
}

async function openShared() {
  const storage = makeStorage({
    [LS_KEY]: { version: 1, activeTripId: 'M', trips: [{ id: 'M', name: 'My own plans', currency: 'USD', items: [] }] },
  });
  const hash = await shareHash({
    name: 'Friend weekend', currency: 'EUR',
    items: [{ type: 'activity', title: 'Cliff walk', location: 'Lisbon', startDate: DAY, startTime: '10:00', status: 'booked' }],
  });
  const app = bootApp({ storage, hash });
  await app.until(() => app.bodyHas('tp-shared'), 'the shared view');
  return { app, storage, owned: storage.get(LS_KEY), bootWrites: app.writes.length };
}

const assistantOpen = (app) => !app.$('#assistPanel').hidden || app.bodyHas('tp-assist-open');

test('T-4 no way into the assistant opens it on a shared trip, and importing the trip brings it back', async () => {
  const { app } = await openShared();
  await app.dayAct('ask-day', DAY);
  assert.equal(assistantOpen(app), false, 'the Days view robot');
  await app.moreRow('#assistBtn');
  assert.equal(assistantOpen(app), false, 'the phone More menu row');
  await app.fire('#assistBtn', 'click');
  assert.equal(assistantOpen(app), false, 'the toolbar button');

  await app.fire('#sharedImport', 'click');
  assert.equal(app.bodyHas('tp-shared'), false);
  await app.dayAct('ask-day', DAY);
  assert.equal(assistantOpen(app), true, 'on the imported trip the assistant is live again');
});

test('T-4 a message sent from a shared trip reaches no model and stores nothing on this device', async () => {
  const { app, storage, owned, bootWrites } = await openShared();
  app.$('#assistInput').value = 'Plan my day';
  await app.fire('#assistSend', 'click');
  await app.settle();
  assert.deepEqual(app.fetches.filter((u) => /tp-assist|openai|generativelanguage/.test(u)), []);
  assert.deepEqual(app.writes.slice(bootWrites), [], 'no chat thread for a stranger\'s trip either');
  assert.equal(storage.get(LS_KEY), owned);
});

test('T-4 a proposal cannot be accepted onto a shared trip, so nothing is shown as added that a reload would lose', async () => {
  const { app, storage, owned } = await openShared();
  app.$('#assistPasteBox').value = 'Here you go.\n```json\n'
    + JSON.stringify({ tripActions: [{ op: 'add', item: { type: 'activity', title: 'Fado night', location: 'Lisbon', startDate: DAY, startTime: '21:00' } }] })
    + '\n```';
  await Promise.all(app.$('#assistTierBody').dispatch('click', { target: target({ matches: ['#assistPasteParse'] }) }));
  const cards = app.proposalCards('#assistMessages');
  assert.ok(cards.length, 'fixture: the pasted reply produced a card');
  const btn = target({ dataset: { act: 'accept-proposal' }, matches: ['button[data-act]'], closest: { '.assist-proposal': cards[0] } });
  await Promise.all(app.$('#assistMessages').dispatch('click', { target: btn }));
  assert.doesNotMatch(app.$('#board').innerHTML, /Fado night/, 'the shared board never shows the item');
  assert.equal(storage.get(LS_KEY), owned);
});

test('T-4 the phone More menu cannot open the whole-trip shift on a shared trip', async () => {
  const { app } = await openShared();
  await app.moreRow('#shiftTripBtn');
  assert.equal(app.overlayOpen('#shiftOverlay'), false);
});

test('T-4 the visa checker reads a shared trip but adds no country and no reminder to it', async () => {
  const { app, storage, owned } = await openShared();
  await app.fire('#visaBtn', 'click');
  assert.equal(app.overlayOpen('#visaOverlay'), true, 'reading the visa rules of a shared trip is allowed');
  app.$('#visaAddSel').value = 'JP';
  await app.fire('#visaAddSel', 'change');
  assert.doesNotMatch(app.$('#visaResults').innerHTML, /Japan/, 'no country is added to the trip on screen');
  const remind = target({ dataset: { remindCc: 'IN', remindName: 'India' }, matches: ['button[data-remind-cc]'] });
  await Promise.all(app.$('#visaResults').dispatch('click', { target: remind }));
  assert.doesNotMatch(app.$('#board').innerHTML, /Apply for India visa/, 'no reminder row appears');
  assert.equal(storage.get(LS_KEY), owned);
});
