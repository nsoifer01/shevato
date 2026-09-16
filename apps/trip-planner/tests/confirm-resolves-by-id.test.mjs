// A confirm dialog commits to the trip it was OPENED for, found again by id.
//
// The four destructive confirms (item delete, clear day, bulk delete, bulk
// currency change) captured the trip and item OBJECTS when they opened, and a
// confirm stays open for as long as it takes somebody to read it. A sync
// delivery in that window replaces `db` wholesale, so the captured objects
// become orphans: pressing Yes spliced an array nobody was looking at any
// more, `save()` wrote the NEW db unchanged, and the success toast fired for a
// delete that never happened. No wrong-trip write, but "Deleted" on screen and
// the item still there after a reload is worse than an error would have been.
//
// This was recorded in FINDINGS.md as audit F9/P3 with the fix already named
// ("re-resolve by id inside the confirm's action, the way tripForWrite does")
// and left unfixed. The sibling class - dialogs that resolve activeTrip() at
// SAVE time instead of pinning it - is pinned by dialog-trip-pins.test.mjs;
// this file is the same rule for the confirm path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, makeStorage, target, trip, item, dbOf, LS_KEY } from './app-harness.mjs';

const DAY = '2027-06-10';

/** A trip whose delete needs a confirm: `stay` is a STRUCTURAL_TYPES member. */
function fixture() {
  const A = trip('A', 'Lisbon', [
    item({ id: 'a1', type: 'stay', title: 'Hotel Baixa', location: 'Lisbon', startDate: DAY, endDate: '2027-06-12' }),
    item({ id: 'a2', type: 'activity', title: 'Tram 28', location: 'Lisbon', startDate: DAY }),
  ]);
  const storage = makeStorage({ [LS_KEY]: dbOf([A], 'A') });
  const app = bootApp({ storage });
  assert.equal(app.openTripId(), 'A', 'fixture: the page opens on trip A');
  return { app, storage };
}

const storedItems = (storage, id = 'A') => {
  const t = storage.json(LS_KEY).trips.find((x) => x.id === id);
  return t ? t.items.map((i) => i.id) : null;
};

/** The same trip and items, as a DIFFERENT object graph: what a delivery hands us. */
const redelivered = (storage) => JSON.parse(JSON.stringify(storage.json(LS_KEY)));

async function openDeleteConfirm(app, id) {
  const btn = target({ dataset: { act: 'delete', id }, matches: ['button[data-act]'] });
  await Promise.all(app.$('#daysList').dispatch('click', { target: btn }));
  assert.ok(app.overlayOpen('#confirmOverlay'), 'the delete confirm should be open');
}

test('a delivery between opening a delete confirm and pressing Yes does not swallow the delete', async () => {
  const { app, storage } = fixture();
  await openDeleteConfirm(app, 'a1');

  // The db is replaced underneath the open dialog, exactly as a Firestore
  // snapshot does: same trip, same items, all-new objects.
  app.deliverRemote(LS_KEY, redelivered(storage));

  await app.fire('#confirmYes', 'click');
  await app.settle();

  assert.deepEqual(storedItems(storage), ['a2'],
    'the stay must actually be gone from the STORED trip, not from an orphaned copy');
  // toasts() strips tags but leaves entities, so the title arrives as &quot;.
  assert.ok(app.toasts().some((t) => /^Deleted\b/.test(t) && /Hotel Baixa/.test(t)),
    'and the delete should be reported');
});

test('a confirm whose trip was deleted elsewhere refuses out loud and writes nothing', async () => {
  const { app, storage } = fixture();
  await openDeleteConfirm(app, 'a1');

  // The trip itself is gone on another device. There is nothing to re-resolve,
  // so the action must say so rather than mutate the orphan and claim success.
  const B = trip('B', 'Tokyo', [item({ id: 'b1', title: 'Sushi class', startDate: DAY })]);
  app.deliverRemote(LS_KEY, dbOf([B], 'B'));

  await app.fire('#confirmYes', 'click');
  await app.settle();

  assert.equal(storedItems(storage, 'A'), null, 'trip A is gone, as delivered');
  assert.deepEqual(storedItems(storage, 'B'), ['b1'], 'and the bystander trip is untouched');
  // The delivery itself correctly says the open trip went away; what must NOT
  // appear is a success line for the delete the button was pressed for.
  assert.equal(app.toasts().some((t) => /^Deleted\b/.test(t)), false,
    'a delete that did not happen must not report that it did');
  assert.ok(app.toasts().some((t) => /no longer here, so nothing was saved/.test(t)),
    'and the refusal has to be said out loud, not swallowed');
});

test('clearing a day after a delivery clears the stored day', async () => {
  const { app, storage } = fixture();
  const btn = target({ dataset: { act: 'clear-day', date: DAY }, matches: ['button[data-act]'] });
  await Promise.all(app.$('#daysList').dispatch('click', { target: btn }));
  assert.ok(app.overlayOpen('#confirmOverlay'), 'the clear-day confirm should be open');

  app.deliverRemote(LS_KEY, redelivered(storage));
  await app.fire('#confirmYes', 'click');
  await app.settle();

  assert.deepEqual(storedItems(storage), [],
    'both items start on this day, so clearing it must empty the STORED trip');
});
