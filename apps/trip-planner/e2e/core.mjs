// Trip Planner E2E: core data workflows.
//   A. bootstrap (fresh load, empty state, no errors)
//   B. create trip -> configure -> add items -> reload -> everything survives
//   C. add / edit / duplicate / delete item lifecycle through the real UI
//   D. undo / redo wiring (buttons and Ctrl+Z / Ctrl+Y)
//   E. double-submit protection (item, shift, duplicate-day dialogs)
//
// The history math and validation rules live in trip-logic and are pinned by
// node:test; these tests protect the UI wiring on top of them.
//
// Every block closes its page in `finally`: a leaked tab shares the profile's
// localStorage and its storage listener reacts to later blocks' writes, which
// produces convincing phantom failures (seen while writing this suite).
import {
  APP, recorder, freshIds, iso, item, trip, dbOf, standardTrip,
  openApp, readDb, rowCount, overlayOpenId,
  tpErrors, menuAct, openAddItem, fillItem, saveItem, addItemViaUi,
  switchView, escape, ctrlKey, expandTimeline, closePage, gotoHard, evaluate,
  clickSel, setValue, waitForExpr,
} from './helpers.mjs';

export async function run({ base, cdpPort }) {
  const R = [];
  const t = recorder(R);

  // One block = one fresh page, closed even when the block throws.
  const withPage = async (label, opts, fn) => {
    let s = null;
    try {
      s = await openApp(cdpPort, base, opts);
      await fn(s);
      await t(`${label}: no page errors`, tpErrors(s).length === 0, tpErrors(s).slice(0, 2).join(' | '), s);
    } catch (e) {
      await t(`${label}: block ran`, false, String(e && e.message).slice(0, 140), s);
    } finally {
      if (s) try { await closePage(cdpPort, s); } catch { /* already gone */ }
    }
  };

  /* ------------------------- A. bootstrap ------------------------------- */
  freshIds();
  await withPage('tp-core A', {}, async (s) => {
    const db = await readDb(s);
    await t('tp-core A: fresh boot creates the default db', !!db && db.trips.length === 1 && db.trips[0].name === 'My trip', JSON.stringify(db && db.trips.map(x => x.name)), s);
    await t('tp-core A: empty state offers the example loader', await evaluate(s, `!!document.getElementById('emptySample')`), '', s);
    const disabled = await evaluate(s, `({days: document.getElementById('viewDays').disabled, map: document.getElementById('viewMap').disabled})`);
    await t('tp-core A: Days and Map disabled with no items', disabled.days && disabled.map, JSON.stringify(disabled), s);
    const undoState = await evaluate(s, `({u: document.getElementById('undoBtn').disabled, r: document.getElementById('redoBtn').disabled})`);
    await t('tp-core A: undo and redo start disabled', undoState.u && undoState.r, JSON.stringify(undoState), s);
  });

  /* --------- B. create trip -> items -> reload -> persistence ----------- */
  freshIds();
  await withPage('tp-core B', {}, async (s) => {
    await menuAct(s, 'new-trip');
    await t('tp-core B: New trip opens the trip dialog', (await overlayOpenId(s)) === 'tripOverlay', '', s);
    await setValue(s, '#inTripName', 'Honeymoon E2E');
    await setValue(s, '#inTripCurrency', 'EUR');
    await clickSel(s, '#tripSaveBtn', { settle: 700 });
    let db = await readDb(s);
    const created = db.trips.find(x => x.name === 'Honeymoon E2E');
    await t('tp-core B: trip created and active', !!created && db.activeTripId === created.id && created.currency === 'EUR', JSON.stringify(db.trips.map(x => x.name)), s);

    const d = 40;
    await t('tp-core B: flight added via the form', await addItemViaUi(s, {
      type: 'flight', title: 'Lisbon (LIS) to Ponta Delgada (PDL)', start: iso(d), time: '09:30',
      arrDate: iso(d), arrTime: '11:45', status: 'booked', cost: '210', confirmation: 'AZ0RES',
    }), '', s);
    await t('tp-core B: stay added via the form', await addItemViaUi(s, {
      type: 'stay', title: 'Azor Hotel', place: 'Ponta Delgada', start: iso(d), end: iso(d + 3), status: 'booked', cost: '540',
    }), '', s);
    await t('tp-core B: activity added via the form', await addItemViaUi(s, {
      type: 'activity', title: 'Sete Cidades hike', place: 'Ponta Delgada', start: iso(d + 1), time: '10:00', status: 'to-book',
    }), '', s);

    await expandTimeline(s);
    await t('tp-core B: all three render on the timeline', (await rowCount(s)) === 3, `rows=${await rowCount(s)}`, s);
    db = await readDb(s);
    const tr = db.trips.find(x => x.name === 'Honeymoon E2E');
    const flight = tr.items.find(x => x.type === 'flight');
    await t('tp-core B: stored fields round-trip', tr.items.length === 3
      && flight && flight.startTime === '09:30' && flight.endTime === '11:45' && flight.cost === 210 && flight.confirmation === 'AZ0RES',
      JSON.stringify(flight), s);

    await switchView(s, 'days');
    await gotoHard(s, base + APP + '#days', { settle: 900 });
    db = await readDb(s);
    const after = db.trips.find(x => x.name === 'Honeymoon E2E');
    await t('tp-core B: trip and items survive a reload', !!after && after.items.length === 3 && db.activeTripId === after.id, '', s);
    await t('tp-core B: view survives a reload via its hash', await evaluate(s, `document.getElementById('viewDays').classList.contains('on')`), '', s);
    await t('tp-core B: reloaded Days view shows the stay', await evaluate(s, `document.getElementById('daysList').innerText.includes('Azor Hotel')`), '', s);
  });

  /* ----------------- C. item lifecycle: edit / dup / delete -------------- */
  freshIds();
  const seedC = standardTrip();
  await withPage('tp-core C', { db: dbOf([seedC]) }, async (s) => {
    const sushi = seedC.items.find(x => x.title === 'Sushi making class');
    await t('tp-core C: collapsed stay groups expand', await expandTimeline(s), '', s);

    // edit
    await clickSel(s, `.tp-row[data-id="${sushi.id}"] [data-act="edit"]`, { settle: 500 });
    await t('tp-core C: edit opens with the item loaded', (await overlayOpenId(s)) === 'itemOverlay'
      && (await evaluate(s, `document.getElementById('inTitle').value`)) === 'Sushi making class', '', s);
    await fillItem(s, { title: 'Sushi masterclass', cost: '85', status: 'booked', time: '12:30' });
    await saveItem(s);
    let db = await readDb(s);
    let edited = db.trips[0].items.find(x => x.id === sushi.id);
    await t('tp-core C: edit persists to storage', edited && edited.title === 'Sushi masterclass' && edited.cost === 85 && edited.status === 'booked' && edited.startTime === '12:30', JSON.stringify(edited), s);
    await expandTimeline(s);
    await t('tp-core C: edit re-renders the row', await evaluate(s, `!!document.querySelector('.tp-row[data-id="${sushi.id}"] .c-title') && document.querySelector('.tp-row[data-id="${sushi.id}"] .c-title').textContent.includes('Sushi masterclass')`), '', s);

    // duplicate
    const before = db.trips[0].items.length;
    await clickSel(s, `.tp-row[data-id="${sushi.id}"] [data-act="duplicate"]`, { settle: 600 });
    db = await readDb(s);
    await t('tp-core C: duplicate adds exactly one copy', db.trips[0].items.length === before + 1
      && db.trips[0].items.filter(x => x.title.includes('Sushi masterclass')).length === 2, `items=${db.trips[0].items.length}`, s);

    // delete the copy (activity: no confirm dialog, undo via toast)
    const copy = db.trips[0].items.find(x => x.id !== sushi.id && x.title.includes('Sushi masterclass'));
    await expandTimeline(s);
    await clickSel(s, `.tp-row[data-id="${copy.id}"] [data-act="delete"]`, { settle: 600 });
    db = await readDb(s);
    await t('tp-core C: deleting the copy leaves the original', db.trips[0].items.length === before
      && !!db.trips[0].items.find(x => x.id === sushi.id) && !db.trips[0].items.find(x => x.id === copy.id), '', s);

    // delete a stay: structural, so the confirm dialog must gate it
    const stay = seedC.items.find(x => x.title === 'Kyoto Ryokan');
    await clickSel(s, `.tp-row[data-id="${stay.id}"] [data-act="delete"]`, { settle: 500 });
    await t('tp-core C: structural delete asks first', (await overlayOpenId(s)) === 'confirmOverlay', '', s);
    await clickSel(s, '#confirmYes', { settle: 600 });
    db = await readDb(s);
    await t('tp-core C: confirmed delete removes the stay', !db.trips[0].items.find(x => x.id === stay.id), '', s);

    // cancelling a structural delete must remove nothing
    const stayA = seedC.items.find(x => x.title === 'Tokyo Grand Hotel');
    await clickSel(s, `.tp-row[data-id="${stayA.id}"] [data-act="delete"]`, { settle: 400 });
    await escape(s);
    await waitForExpr(s, `!document.querySelector('.overlay.open')`, { timeout: 4000 });
    db = await readDb(s);
    await t('tp-core C: cancelled delete removes nothing', !!db.trips[0].items.find(x => x.id === stayA.id), '', s);
  });

  /* ---------------------------- D. undo / redo --------------------------- */
  freshIds();
  const seedD = standardTrip();
  await withPage('tp-core D', { db: dbOf([seedD]) }, async (s) => {
    const n0 = seedD.items.length;
    const count = async () => (await readDb(s)).trips[0].items.length;

    // add -> undo -> redo (buttons)
    await addItemViaUi(s, { type: 'activity', title: 'Undoable dinner', start: iso(32), time: '19:00' });
    await clickSel(s, '#undoBtn', { settle: 600 });
    await t('tp-core D: undo reverses an add (storage)', (await count()) === n0, `items=${await count()}`, s);
    await t('tp-core D: undo reverses an add (DOM)', !(await evaluate(s, `document.getElementById('board').innerText.includes('Undoable dinner')`)), '', s);
    await clickSel(s, '#redoBtn', { settle: 600 });
    await t('tp-core D: redo restores the add', (await count()) === n0 + 1, `items=${await count()}`, s);

    // edit -> Ctrl+Z -> Ctrl+Y (keyboard)
    const sushi = seedD.items.find(x => x.title === 'Sushi making class');
    await expandTimeline(s);
    await clickSel(s, `.tp-row[data-id="${sushi.id}"] [data-act="edit"]`, { settle: 400 });
    await fillItem(s, { title: 'Renamed by edit' });
    await saveItem(s);
    await ctrlKey(s, 'z', 90);
    await waitForExpr(s, `JSON.parse(localStorage.getItem('trip-planner:v1')).trips[0].items.some(x=>x.id===${JSON.stringify(sushi.id)} && x.title==='Sushi making class')`, { timeout: 6000 });
    let db = await readDb(s);
    await t('tp-core D: Ctrl+Z reverses an edit', db.trips[0].items.find(x => x.id === sushi.id).title === 'Sushi making class', '', s);
    await ctrlKey(s, 'y', 89);
    await waitForExpr(s, `JSON.parse(localStorage.getItem('trip-planner:v1')).trips[0].items.some(x=>x.id===${JSON.stringify(sushi.id)} && x.title==='Renamed by edit')`, { timeout: 6000 });
    db = await readDb(s);
    await t('tp-core D: Ctrl+Y restores the edit', db.trips[0].items.find(x => x.id === sushi.id).title === 'Renamed by edit', '', s);

    // delete -> undo
    await expandTimeline(s);
    await clickSel(s, `.tp-row[data-id="${sushi.id}"] [data-act="delete"]`, { settle: 500 });
    await clickSel(s, '#undoBtn', { settle: 600 });
    db = await readDb(s);
    await t('tp-core D: undo restores a deleted item', !!db.trips[0].items.find(x => x.id === sushi.id), '', s);

    // status quick-change -> undo
    const bus = seedD.items.find(x => x.title === 'Airport Limousine Bus');
    await expandTimeline(s);
    await setValue(s, `.tp-row[data-id="${bus.id}"] .status-sel`, 'booked');
    await waitForExpr(s, `JSON.parse(localStorage.getItem('trip-planner:v1')).trips[0].items.find(x=>x.id===${JSON.stringify(bus.id)}).status==='booked'`, { timeout: 6000 });
    db = await readDb(s);
    await t('tp-core D: row status select writes through', db.trips[0].items.find(x => x.id === bus.id).status === 'booked', '', s);
    await clickSel(s, '#undoBtn', { settle: 600 });
    db = await readDb(s);
    await t('tp-core D: undo reverses a status change', db.trips[0].items.find(x => x.id === bus.id).status === 'to-book', '', s);
  });

  /* ----------------------- E. double-submit guards ----------------------- */
  freshIds();
  const seedE = standardTrip();
  await withPage('tp-core E', { db: dbOf([seedE]) }, async (s) => {
    const n0 = seedE.items.length;

    // Two submit events with no intervening render: exactly what a double-click
    // on Save or two rapid Enter presses produce. requestSubmit() drives the
    // same submit handler a user reaches, synchronously, so the race is
    // deterministic instead of timing-dependent.
    await openAddItem(s);
    await fillItem(s, { type: 'activity', title: 'Doubled?', start: iso(33), time: '18:00' });
    await evaluate(s, `(()=>{ const f=document.getElementById('itemForm'); f.requestSubmit(); f.requestSubmit(); return 1 })()`);
    // both submits run synchronously in that evaluate; the wait is only for
    // the save to be visible in storage, and a wrongly doubled add would
    // already be there too
    await waitForExpr(s, `JSON.parse(localStorage.getItem('trip-planner:v1')).trips[0].items.length >= ${n0 + 1}`, { timeout: 6000 });
    let db = await readDb(s);
    await t('tp-core E: double submit adds ONE item', db.trips[0].items.filter(x => x.title === 'Doubled?').length === 1
      && db.trips[0].items.length === n0 + 1, `items=${db.trips[0].items.length}`, s);

    // shift-trip dialog: the whole trip must move by 1 day, not 2
    await clickSel(s, '#shiftTripBtn', { settle: 400 });
    await setValue(s, '#shiftDays', '1');
    await evaluate(s, `(()=>{ const f=document.getElementById('shiftForm'); f.requestSubmit(); f.requestSubmit(); return 1 })()`);
    await waitForExpr(s, `JSON.parse(localStorage.getItem('trip-planner:v1')).trips[0].items.find(x=>x.type==='flight').startDate !== ${JSON.stringify(iso(30))}`, { timeout: 6000 });
    db = await readDb(s);
    const flightAfter = db.trips[0].items.find(x => x.type === 'flight').startDate;
    await t('tp-core E: double submit shifts dates ONCE', flightAfter === iso(31), `flight now ${flightAfter} (want ${iso(31)})`, s);

    // duplicate-day dialog: each item on the day is copied once, not twice.
    // The action lives in the day card's "..." overflow menu now, so the menu
    // opens first (a hidden menu item is a zero-rect and clickSel refuses it).
    await switchView(s, 'days');
    const srcDate = iso(34); // post-shift home of 'Doubled?' (33+1) and 'Buy JR Pass' (30+3+1)
    const target = iso(60);
    await clickSel(s, `.day-card[data-date="${srcDate}"] [data-act="day-menu"]`, { settle: 300 });
    await clickSel(s, `.day-card[data-date="${srcDate}"] [data-act="duplicate-day"]`, { settle: 500 });
    const dupOpen = (await overlayOpenId(s)) === 'dupDayOverlay';
    await t('tp-core E: duplicate-day dialog opens', dupOpen, `date=${srcDate} overlay=${await overlayOpenId(s)}`, s);
    if (dupOpen) {
      const srcCount = db.trips[0].items.filter(x => x.startDate === srcDate).length;
      await setValue(s, '#dupDayDate', target);
      await evaluate(s, `(()=>{ const f=document.getElementById('dupDayForm'); f.requestSubmit(); f.requestSubmit(); return 1 })()`);
      await waitForExpr(s, `JSON.parse(localStorage.getItem('trip-planner:v1')).trips[0].items.some(x=>x.startDate===${JSON.stringify(target)})`, { timeout: 6000 });
      db = await readDb(s);
      const copies = db.trips[0].items.filter(x => x.startDate === target);
      await t('tp-core E: double submit copies the day ONCE', copies.length === srcCount
        && copies.filter(x => x.title === 'Doubled? (copy)').length === 1, `src=${srcCount} copies=${copies.length}`, s);
    }
  });

  /* ------------------- S. item count summary chip ------------------------ */
  // The Items chip is a WHOLE-TRIP count of non-cancelled items (the rule is
  // pinned in trip-logic tests); this block protects the UI wiring: every
  // mutation path repaints it, filters never touch it, and it survives trip
  // switches and reloads.
  freshIds();
  const seedS = standardTrip(); // 8 items, one cancelled -> 7 active
  const soloS = trip({ name: 'Solo count', items: [item({ title: 'Single plan', startDate: iso(80), startTime: '10:00' })] });
  await withPage('tp-core S', { db: dbOf([seedS, soloS], seedS.id) }, async (s) => {
    const chipText = () => evaluate(s, `(()=>{const c=[...document.querySelectorAll('#summary .chip')]
      .find(x=>{const k=x.querySelector('.k'); return k && k.textContent.trim()==='Items'});
      return c ? c.querySelector('.v').textContent.trim() : null})()`);
    // waits on the repainted chip itself: the chip IS the thing under test,
    // so "it eventually reads X" is exactly the observable condition
    // The chip reads "{n} items" plus, when the trip holds any, "+ {n}
    // cancelled": selection and the delete confirm count cancelled rows, so the
    // chip has to say which set its own number is about (QA TP-13). These read
    // the COUNT, and the cancelled tail is asserted separately below.
    const chipCount = async () => String(await chipText() || '').split('+')[0].trim();
    const chipReads = (want) => waitForExpr(s, `(()=>{const c=[...document.querySelectorAll('#summary .chip')]
      .find(x=>{const k=x.querySelector('.k'); return k && k.textContent.trim()==='Items'});
      return !!c && c.querySelector('.v').textContent.trim().split('+')[0].trim() === ${JSON.stringify(want)}})()`, { timeout: 6000 });
    await t('tp-core S: chip counts active items, not cancelled ones', (await chipCount()) === '7 items', `chip=${await chipText()}`, s);
    await t('tp-core S: and says how many it left out', /\+ 1 cancelled/.test(await chipText()), `chip=${await chipText()}`, s);

    await addItemViaUi(s, { type: 'activity', title: 'Count me', start: iso(40), time: '09:00' });
    await t('tp-core S: add raises the count', (await chipCount()) === '8 items', `chip=${await chipText()}`, s);

    const added = (await readDb(s)).trips[0].items.find(x => x.title === 'Count me');
    await setValue(s, `.tp-row[data-id="${added.id}"] .status-sel`, 'cancelled');
    await t('tp-core S: cancelling lowers the count', await chipReads('7 items'), `chip=${await chipText()}`, s);
    await setValue(s, `.tp-row[data-id="${added.id}"] .status-sel`, 'to-book');
    await t('tp-core S: restoring from Cancelled raises it again', await chipReads('8 items'), `chip=${await chipText()}`, s);

    await clickSel(s, `.tp-row[data-id="${added.id}"] [data-act="delete"]`, { settle: 500 });
    await t('tp-core S: delete lowers the count', (await chipCount()) === '7 items', `chip=${await chipText()}`, s);
    await clickSel(s, '#undoBtn', { settle: 600 });
    await t('tp-core S: undo restores the count', (await chipCount()) === '8 items', `chip=${await chipText()}`, s);

    await setValue(s, '#searchBox', 'zzz-no-match');
    // wait for the filter to have visibly applied (empty board), THEN read the
    // chip: this is the one wait that cannot key on the chip, because the
    // claim is that the chip does NOT change
    await waitForExpr(s, `document.querySelectorAll('#board .tp-row').length === 0`, { timeout: 6000 });
    await t('tp-core S: filtering never changes the whole-trip count', (await chipCount()) === '8 items', `chip=${await chipText()}`, s);
    await setValue(s, '#searchBox', '');
    await waitForExpr(s, `document.querySelectorAll('#board .tp-row').length > 0`, { timeout: 6000 });

    await setValue(s, '#tripSelect', soloS.id);
    await t('tp-core S: switching trips switches the count, singular wording', await chipReads('1 item'), `chip=${await chipText()}`, s);
    await setValue(s, '#tripSelect', seedS.id);
    await chipReads('8 items');

    await gotoHard(s, base + APP, { settle: 900 });
    await t('tp-core S: the count survives a reload', (await chipCount()) === '8 items', `chip=${await chipText()}`, s);
  });

  /* ------------------ Z. repairDb straightens bad storage ---------------- */
  // The db has no schema migrations: repairDb() normalizes at boot and writes
  // the repaired shape back, outsideHistory (FINDINGS "Architecture facts").
  // Seed the kind of db a hand-edit or a partial import leaves behind and
  // assert the app renders it repaired rather than crashing: unknown type ->
  // note, unknown status -> to-book, non-ISO currencies -> USD, out-of-range
  // `order` dropped, and the repair never arms Undo.
  freshIds();
  const zGood = item({ title: 'Real plan', startDate: iso(31), startTime: '09:00', status: 'booked', cost: 60, costCurrency: 'usd$' });
  const zBad = item({ title: 'Mystery banquet', type: 'banquet', status: 'maybe', startDate: iso(30), startTime: '10:00' });
  zBad.order = 5000; // >= ORDER_MAX: must be dropped, not sorted as a string
  const zTrip = trip({ name: 'Broken import', currency: 'dollars', items: [zBad, zGood] });
  await withPage('tp-core Z', { db: dbOf([zTrip]) }, async (s) => {
    await t('tp-core Z: a malformed db still renders its items',
      await evaluate(s, `document.getElementById('board').innerText.includes('Mystery banquet') && document.getElementById('board').innerText.includes('Real plan')`), '', s);
    const db = await readDb(s);
    const tz = db.trips.find(x => x.id === zTrip.id);
    const bad = tz.items.find(x => x.id === zBad.id);
    const good = tz.items.find(x => x.id === zGood.id);
    await t('tp-core Z: unknown type repairs to note and unknown status to to-book',
      !!bad && bad.type === 'note' && bad.status === 'to-book', JSON.stringify(bad), s);
    await t('tp-core Z: out-of-range manual order is dropped', !!bad && bad.order === undefined, JSON.stringify(bad && bad.order), s);
    await t('tp-core Z: non-ISO currencies repair to USD (trip and item cost alike)',
      tz.currency === 'USD' && !!good && good.cost === 60 && good.costCurrency === 'USD',
      JSON.stringify({ trip: tz.currency, cost: good && good.cost, cur: good && good.costCurrency }), s);
    // the write-back happened (storage now holds the repaired shape), yet the
    // app straightening its own storage is housekeeping, never an undo step
    await t('tp-core Z: the repair write never arms Undo',
      await evaluate(s, `document.getElementById('undoBtn').disabled`), '', s);
  });

  return R;
}
