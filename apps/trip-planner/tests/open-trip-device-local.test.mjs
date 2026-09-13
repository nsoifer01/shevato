// Which trip is open is this device's business (2026-09-12 audit, T-2).
//
// The open trip id used to live inside the synced value, so any save on
// another device (or another tab) silently switched the trip on screen here,
// and a trip switch was itself a synced write. It is navigation now: kept on
// this device, never uploaded, and an incoming value cannot move it. Trip
// EDITS still travel both ways. Values written by copies of the app that
// predate this still carry `activeTripId`, so every test below that matters
// during a rollout delivers exactly that shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, makeStorage, trip, item, dbOf, LS_KEY } from './app-harness.mjs';

const OPEN_TRIP_KEY = 'trip-planner:open-trip';

const lisbon = () => trip('A', 'Lisbon', [item({ id: 'a1', title: 'Tram 28', startDate: '2027-06-10' })]);
const tokyo = () => trip('B', 'Tokyo', [item({ id: 'b1', title: 'Sushi class', startDate: '2027-09-01' })]);

const switchTo = (app, id) => app.fire('#tripSelect', 'change', { target: { value: id } });
async function saveContact(app, name) {
  await app.menu('essentials');
  app.$('#inEssContactName').value = name;
  await app.fire('#essentialsForm', 'submit');
}
const contactOf = (storage, id) => {
  const t = storage.json(LS_KEY).trips.find((x) => x.id === id);
  return t && t.essentials ? t.essentials.contactName : undefined;
};

test('T-2 switching trips is navigation: it writes nothing that syncs, and this device reopens that trip', async () => {
  const storage = makeStorage({ [LS_KEY]: dbOf([lisbon(), tokyo()], 'A') });
  const app = bootApp({ storage });
  const synced = storage.get(LS_KEY);
  const from = app.writes.length;
  await switchTo(app, 'B');
  assert.equal(app.openTripId(), 'B');
  assert.ok(!app.writes.slice(from).includes(LS_KEY), 'the synced value is not written by a switch');
  assert.equal(storage.get(LS_KEY), synced);
  assert.equal(bootApp({ storage }).openTripId(), 'B', 'a reload on this device opens the trip it had open');
});

test('T-2 another device switching trips and editing never moves this device, and its edit still arrives', async () => {
  const laptop = makeStorage({ [LS_KEY]: dbOf([lisbon(), tokyo()], 'A') });
  const phone = makeStorage({ [LS_KEY]: laptop.get(LS_KEY) });
  const onLaptop = bootApp({ storage: laptop });
  const onPhone = bootApp({ storage: phone });

  await switchTo(onPhone, 'B');
  await saveContact(onPhone, 'Kenji');
  onLaptop.deliverRemote(LS_KEY, phone.get(LS_KEY));

  assert.equal(onLaptop.openTripId(), 'A', 'the laptop still shows Lisbon');
  await saveContact(onLaptop, 'Maria');
  assert.equal(contactOf(laptop, 'A'), 'Maria', 'the laptop\'s edit lands on the trip it has open');
  assert.equal(contactOf(laptop, 'B'), 'Kenji', 'and the phone\'s edit to Tokyo arrived and survived it');

  onPhone.deliverRemote(LS_KEY, laptop.get(LS_KEY));
  assert.equal(onPhone.openTripId(), 'B', 'the laptop\'s save does not move the phone back either');
});

test('T-2 a value from a device on older code names its own open trip: this device neither follows it now nor after a reload', async () => {
  const storage = makeStorage({ [LS_KEY]: dbOf([lisbon(), tokyo()], 'A') });
  const app = bootApp({ storage });
  const fromOldCode = storage.json(LS_KEY);
  fromOldCode.activeTripId = 'B';
  fromOldCode.trips[1].items.push(item({ id: 'b2', title: 'Tsukiji breakfast', startDate: '2027-09-02' }));
  app.deliverRemote(LS_KEY, fromOldCode);
  assert.equal(app.openTripId(), 'A');
  assert.equal(bootApp({ storage }).openTripId(), 'A', 'the reload opens what this device showed, not what the value names');
});

test('T-2 saving here never rewrites the trip the synced value names, so devices on older code are not moved by this one', async () => {
  const storage = makeStorage({ [LS_KEY]: dbOf([lisbon(), tokyo()], 'A') });
  const app = bootApp({ storage });
  await switchTo(app, 'B');
  await saveContact(app, 'Kenji');
  assert.equal(contactOf(storage, 'B'), 'Kenji');
  assert.equal(storage.json(LS_KEY).activeTripId, 'A');
});

test('T-2 a device with no choice of its own opens the trip the synced value names, else the first trip', () => {
  assert.equal(bootApp({ storage: makeStorage({ [LS_KEY]: dbOf([lisbon(), tokyo()], 'B') }) }).openTripId(), 'B');
  assert.equal(bootApp({ storage: makeStorage({ [LS_KEY]: dbOf([lisbon(), tokyo()], 'gone') }) }).openTripId(), 'A');
  const stale = makeStorage({ [LS_KEY]: dbOf([lisbon(), tokyo()], 'B'), [OPEN_TRIP_KEY]: 'deleted-long-ago' });
  assert.equal(bootApp({ storage: stale }).openTripId(), 'B', 'a remembered trip that no longer exists is skipped');
});

test('T-2 the trip open here is deleted on another device: this device moves to another trip, says why, and writes nothing synced on receipt', async () => {
  const storage = makeStorage({ [LS_KEY]: dbOf([lisbon(), tokyo()], 'A') });
  const app = bootApp({ storage });
  const delivered = storage.json(LS_KEY);
  delivered.trips = delivered.trips.filter((t) => t.id !== 'A');
  const from = app.writes.length;
  const toasts = app.toasts().length;
  app.deliverRemote(LS_KEY, delivered);
  assert.equal(app.openTripId(), 'B');
  assert.match(app.toasts().slice(toasts).join(' | '), /deleted on another device/i);
  assert.ok(!app.writes.slice(from).includes(LS_KEY), 'receiving a value never writes the synced value back');

  // The value still names the deleted trip. Older copies of the app rewrite a
  // dangling id on receipt, so the next save publishes one that exists.
  await saveContact(app, 'Kenji');
  assert.equal(storage.json(LS_KEY).activeTripId, 'B');
});

test('T-2 a second tab switching trips does not move the first, while its edits still reach it', async () => {
  const storage = makeStorage({ [LS_KEY]: dbOf([lisbon(), tokyo()], 'A') });
  const tab1 = bootApp({ storage });
  const tab2 = bootApp({ storage });
  const relay = async (action) => {
    const from = tab2.writes.length;
    await action();
    for (const key of new Set(tab2.writes.slice(from))) tab1.storageEvent(key);
  };
  await relay(() => switchTo(tab2, 'B'));
  assert.equal(tab1.openTripId(), 'A');
  await relay(() => saveContact(tab2, 'Kenji'));
  assert.equal(tab1.openTripId(), 'A');
  await saveContact(tab1, 'Maria');
  assert.equal(contactOf(storage, 'A'), 'Maria');
  assert.equal(contactOf(storage, 'B'), 'Kenji');
});
