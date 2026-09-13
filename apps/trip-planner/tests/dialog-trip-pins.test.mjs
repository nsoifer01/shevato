// A dialog writes to the trip it was OPENED for (2026-09-12 audit, T-1).
//
// The db is replaced underneath an open dialog on purpose: a sync delivery or
// another tab's write reloads it, and a remote merge does not close overlays.
// The item, trip and packing dialogs learned long ago to pin their target and
// re-check it at save time; these did not, and resolved `activeTrip()` at the
// moment Save was pressed instead. Two ways that went wrong, both pinned here
// for every such dialog:
//   - the trip on screen changed while the dialog was open, so the emergency
//     contact, the whole-trip shift, the copied day, the visa country or the
//     accepted booking landed on a bystander trip, saved and synced;
//   - the trip was deleted on another device, so the write went to whichever
//     trip took its place, again in silence.
// A save must commit to the pinned trip, or refuse out loud and write nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, makeStorage, target, trip, item, dbOf, LS_KEY } from './app-harness.mjs';

const DAY = '2027-06-10';

function fixture() {
  // Both trips share a date, a visa country and an item on that date, so a
  // write that picks the wrong trip has something to land on and is visible.
  const A = trip('A', 'Lisbon', [item({ id: 'a1', title: 'Tram 28', location: 'Lisbon', startDate: DAY })]);
  const B = trip('B', 'Tokyo', [item({ id: 'b1', title: 'Sushi class', location: 'Tokyo', startDate: DAY })]);
  A.visaExtras = ['FR'];
  B.visaExtras = ['FR'];
  const storage = makeStorage({ [LS_KEY]: dbOf([A, B], 'A') });
  const app = bootApp({ storage });
  assert.equal(app.openTripId(), 'A', 'fixture: the page opens on trip A');
  return { app, storage };
}

const tripIn = (storage, id) => storage.json(LS_KEY).trips.find((t) => t.id === id) || null;

const ICS = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:museum-1',
  'DTSTART;VALUE=DATE:20270611', 'DTEND;VALUE=DATE:20270612', 'SUMMARY:Gulbenkian Museum',
  'END:VEVENT', 'END:VCALENDAR',
].join('\r\n');

// Each entry: how to open the dialog, what to type, how to press Save, and
// how to recognise the edit on a stored trip.
const DIALOGS = [
  {
    name: 'trip essentials',
    open: (app) => app.menu('essentials'),
    fill: (app) => { app.$('#inEssContactName').value = 'Maria Silva'; },
    save: (app) => app.fire('#essentialsForm', 'submit'),
    edited: (t) => !!(t.essentials && t.essentials.contactName === 'Maria Silva'),
  },
  {
    name: 'shift entire trip',
    open: (app) => app.fire('#shiftTripBtn', 'click'),
    fill: (app) => { app.$('#shiftDays').value = '2'; },
    save: (app) => app.fire('#shiftForm', 'submit'),
    edited: (t) => t.items.some((it) => it.startDate === '2027-06-12'),
  },
  {
    name: 'shift one item',
    open: async (app) => {
      const row = target({ dataset: { id: 'a1' } });
      const btn = target({ dataset: { act: 'shift-item' }, matches: ['button[data-act]'], closest: { '.tp-row': row } });
      await Promise.all(app.$('#board').dispatch('click', { target: btn }));
    },
    fill: (app) => {
      app.$('#shiftDays').value = '3';
      app.$('input[name="shiftScope"]:checked').value = 'one';
    },
    save: (app) => app.fire('#shiftForm', 'submit'),
    edited: (t) => t.items.some((it) => it.id === 'a1' && it.startDate === '2027-06-13'),
  },
  {
    name: 'copy day to another date',
    open: (app) => app.dayAct('duplicate-day', DAY),
    fill: (app) => { app.$('#dupDayDate').value = '2027-06-11'; },
    save: (app) => app.fire('#dupDayForm', 'submit'),
    edited: (t) => t.items.some((it) => / \(copy\)$/.test(it.title) && it.startDate === '2027-06-11'),
  },
  {
    name: 'visa check: add a country',
    open: (app) => app.fire('#visaBtn', 'click'),
    fill: (app) => { app.$('#visaAddSel').value = 'JP'; },
    save: (app) => app.fire('#visaAddSel', 'change'),
    edited: (t) => (t.visaExtras || []).includes('JP'),
  },
  {
    name: 'visa check: remove a country',
    open: (app) => app.fire('#visaBtn', 'click'),
    fill: () => {},
    save: async (app) => {
      const btn = target({ dataset: { removeCc: 'FR' }, matches: ['button[data-remove-cc]'] });
      await Promise.all(app.$('#visaResults').dispatch('click', { target: btn }));
    },
    edited: (t) => !(t.visaExtras || []).includes('FR'),
  },
  {
    name: 'visa check: add a reminder',
    open: (app) => app.fire('#visaBtn', 'click'),
    fill: () => {},
    save: async (app) => {
      const btn = target({ dataset: { remindCc: 'IN', remindName: 'India' }, matches: ['button[data-remind-cc]'] });
      await Promise.all(app.$('#visaResults').dispatch('click', { target: btn }));
    },
    edited: (t) => t.items.some((it) => it.title === 'Apply for India visa'),
  },
  {
    name: 'add item',
    open: (app) => app.fire('#addBtn', 'click'),
    fill: (app) => {
      app.$('#inTitle').value = 'Fado night';
      app.$('#inStart').value = '2027-06-11';
      app.$('#inTime').value = '21:00';
      app.$('#inStatus').value = 'to-book';
    },
    save: (app) => app.fire('#itemForm', 'submit'),
    edited: (t) => t.items.some((it) => it.title === 'Fado night'),
  },
  {
    name: 'read a booking: accept what it found',
    open: (app) => app.menu('import-booking'),
    // the cards are read and validated while trip A is the one on screen
    fill: async (app) => {
      await app.fire('#importBookingPaste', 'input', { target: { value: ICS } });
      app.runTimers();
      assert.ok(app.proposalCards('#importBookingResult').length, 'fixture: the calendar file produced a card');
    },
    save: async (app) => {
      const card = app.proposalCards('#importBookingResult')[0];
      const btn = target({ dataset: { act: 'accept-proposal' }, matches: ['button[data-act]'], closest: { '.assist-proposal': card } });
      await Promise.all(app.$('#importBookingResult').dispatch('click', { target: btn }));
    },
    edited: (t) => t.items.some((it) => it.title === 'Gulbenkian Museum'),
  },
];

for (const d of DIALOGS) {
  test(`T-1 ${d.name}: the trip on screen changes while it is open, and Save still edits the trip it was opened for`, async () => {
    const { app, storage } = fixture();
    const bBefore = JSON.stringify(tripIn(storage, 'B'));
    await d.open(app);
    await d.fill(app);
    // A value from a device that names trip B as the open one (an older copy of
    // the app still writes that field into the synced value).
    const delivered = storage.json(LS_KEY);
    delivered.activeTripId = 'B';
    app.deliverRemote(LS_KEY, delivered);
    await d.save(app);
    assert.ok(d.edited(tripIn(storage, 'A')), 'the edit is stored on trip A, the trip the dialog was opened for');
    assert.equal(JSON.stringify(tripIn(storage, 'B')), bBefore, 'trip B is untouched');
  });

  test(`T-1 ${d.name}: the trip is deleted on another device while it is open, and Save writes nothing anywhere and says so`, async () => {
    const { app, storage } = fixture();
    await d.open(app);
    await d.fill(app);
    const delivered = storage.json(LS_KEY);
    delivered.trips = delivered.trips.filter((t) => t.id !== 'A');
    app.deliverRemote(LS_KEY, delivered);
    const stored = storage.get(LS_KEY);
    const toastsBefore = app.toasts().length;
    await d.save(app);
    assert.equal(storage.get(LS_KEY), stored, 'nothing is written: not to trip B, not anywhere');
    const said = app.toasts().slice(toastsBefore);
    assert.ok(said.length > 0 && said.every((t) => /no longer here/i.test(t)),
      `the traveller is told the trip is gone, and nothing claims success: ${JSON.stringify(said)}`);
  });
}

test('T-1 an edit that arrives for the same trip while a dialog is open is kept by its Save (resolved at write time, never a stale copy)', async () => {
  const { app, storage } = fixture();
  await app.menu('essentials');
  app.$('#inEssContactName').value = 'Maria Silva';
  const delivered = storage.json(LS_KEY);
  delivered.trips[0].items.push(item({ id: 'a2', title: 'Pasteis de Belem', location: 'Lisbon', startDate: DAY }));
  app.deliverRemote(LS_KEY, delivered);
  await app.fire('#essentialsForm', 'submit');
  const A = tripIn(storage, 'A');
  assert.equal(A.essentials && A.essentials.contactName, 'Maria Silva');
  assert.ok(A.items.some((it) => it.id === 'a2'), 'the other device\'s item survives the save');
});
