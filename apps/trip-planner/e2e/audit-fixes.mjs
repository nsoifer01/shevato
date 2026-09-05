// Trip Planner E2E: the 2026-08-22 audit round (see AUDIT-2026-08-22.md).
//
// The findings from that round whose fix is a DOM or state fact, so they belong
// in a browser rather than in tests/audit-2026-08-22.test.js (which owns the
// pure logic: connection warnings and night coverage). One block per finding,
// named by its id:
//
//   CR-01  importing a shared trip cannot overwrite a concurrent write
//   CR-02  the trip-delete confirm names the attachments undo cannot restore
//   CR-03  a selection never survives arriving at another trip
//   AS-05  the packing dialog writes to ITS trip, or says nothing was saved
//   AS-07  a malformed share link is handled, not an uncaught rejection
//   DM-05  storage of the wrong shape is repaired instead of emptying a view
//   DM-06  a trip with no stay at all reports its uncovered nights
//   CR-04  a rate table that never arrived is not blamed on the currency
//   AS-02  an assistant update by the id the model was given lands on that item
//   AS-03  an assistant update never un-books what the traveller booked
//   AS-C1  a suggestion already on the plan says so
//   DM-02  a visa reminder is a deadline, not thirty extra days of trip
//   DM-03  switching currency converts the budget instead of relabelling it
//   HR-01  a venue that has not opened yet says so, instead of "Closed at"
//   MV-01  a handover day measures from the hotel it wakes up in
//   MV-02  row actions are reachable on a touch device of any width
//   MV-03  printing works when the browser does not print backgrounds
//   AS-04  the assistant panel makes room instead of covering the toolbar
//   MV-C1  a tapped view is on screen on a phone
//   MV-B1  the day menu's arrow keys do what its ARIA promises
//   MV-B2  a read-only board does not wear editable controls
//   DM-08  an unbreakable title does not scroll the page
//   PP-01  a failed place lookup is not re-asked by every consumer
//   PP-02  a failed weather lookup is not re-asked on every render
//   PP-04  a cancelled row costs no billed venue lookup
//   AS-06  an imported date outside the app's own range is cleared, not kept
//   DM-10  two items can never share an id
import {
  APP, recorder, freshIds, iso, item, trip, dbOf,
  openApp, openTab, readDb, activeTripOf, tpErrors, closePage, evaluate, evalAsync, waitForExpr, standardTrip, pressKey,
  clickSel, setValue, switchView, menuAct, addItemViaUi, escape, ctrlKey,
  toastText, overlayOpenId, sleep, buildShareHash, gotoHard,
} from './helpers.mjs';

export async function run({ base, cdpPort }) {
  const R = [];
  const t = recorder(R);

  const withPage = async (label, opts, fn) => {
    let s = null;
    try {
      s = await openApp(cdpPort, base, opts);
      await fn(s);
      await t(`${label}: no page errors`, tpErrors(s).length === 0, tpErrors(s).slice(0, 2).join(' | '), s);
    } catch (e) {
      await t(`${label}: block ran`, false, String(e && e.message).slice(0, 160), s);
    } finally {
      if (s) try { await closePage(cdpPort, s); } catch { /* gone */ }
    }
  };

  /* ===== CR-01: a shared view owns the screen, never the visitor's data ====
     Reported as a data-loss path: the share view snapshotted the whole db on
     entry, both reconcile listeners deliberately stand down while it is open,
     and "Import as my trip" then wrote that snapshot back - publishing a
     minutes-old copy of the visitor's db over anything another tab (or a sync
     merge) had saved in the meantime, with nothing to undo from in the tab
     that made the edits. */
  freshIds();
  const mine = trip({
    name: 'Mine', currency: 'USD',
    items: [
      item({ type: 'flight', title: 'Home to Tokyo', startDate: iso(30), startTime: '08:00' }),
      item({ type: 'stay', title: 'Tokyo Hotel', location: 'Tokyo', startDate: iso(30), endDate: iso(33) }),
    ],
  });
  const friend = trip({ name: 'Friend trip', items: [item({ title: 'Friend museum', location: 'Kyoto', startDate: iso(31) })] });
  {
    let a = null, b = null;
    try {
      a = await openApp(cdpPort, base, { db: dbOf([mine]) });
      const hash = await buildShareHash(a, friend);
      await t('tp-audit CR-01: a share link was built', !!hash, String(hash).slice(0, 24), a);
      // tab B opens the stranger's itinerary; tab A carries on planning
      b = await openTab(cdpPort, base, { hash });
      await t('tp-audit CR-01: the second tab is in shared mode',
        await evaluate(b, `document.body.classList.contains('tp-shared') && !!document.getElementById('sharedImport')`), '', b);

      const added = await addItemViaUi(a, { title: 'Booked while the link was open', start: iso(32) });
      await t('tp-audit CR-01: the other tab saved a new item', added, '', a);
      const beforeImport = await readDb(a);
      const mineBefore = beforeImport.trips.find(x => x.id === mine.id);
      await t('tp-audit CR-01: storage holds that item before the import',
        !!mineBefore && mineBefore.items.length === 3, `items=${mineBefore && mineBefore.items.length}`, a);

      await clickSel(b, '#sharedImport', { settle: 900 });
      await waitForExpr(b, `!document.body.classList.contains('tp-shared')`);
      const after = await readDb(b);
      const mineAfter = after.trips.find(x => x.id === mine.id);
      const imported = after.trips.find(x => x.name === 'Friend trip');
      // THE assertion this whole block exists for
      await t('tp-audit CR-01: the concurrent edit survives the import',
        !!mineAfter && mineAfter.items.length === 3 && mineAfter.items.some(i => i.title === 'Booked while the link was open'),
        `items=${mineAfter && mineAfter.items.length}`, b);
      await t('tp-audit CR-01: the shared trip was imported alongside it',
        !!imported && imported.items.length === 1 && after.trips.length === 2,
        `trips=${after.trips.map(x => x.name).join(',')}`, b);
      await t('tp-audit CR-01: the import switched to the imported trip',
        after.activeTripId === (imported && imported.id), '', b);
      // undo restores the db as STORAGE held it, not as the stale snapshot did
      await ctrlKey(b, 'z', 90);
      await sleep(400);
      const undone = await readDb(b);
      const mineUndone = undone.trips.find(x => x.id === mine.id);
      await t('tp-audit CR-01: undo removes the import and keeps the concurrent edit',
        undone.trips.length === 1 && !!mineUndone && mineUndone.items.length === 3,
        `trips=${undone.trips.length} items=${mineUndone && mineUndone.items.length}`, b);
      await t('tp-audit CR-01: no page errors', tpErrors(a).length === 0 && tpErrors(b).length === 0,
        [...tpErrors(a), ...tpErrors(b)].slice(0, 2).join(' | '), b);
    } catch (e) {
      await t('tp-audit CR-01: block ran', false, String(e && e.message).slice(0, 160), b || a);
    } finally {
      for (const p of [a, b]) if (p) try { await closePage(cdpPort, p); } catch { /* gone */ }
    }
  }

  /* ===== AS-07: a share link that cannot be decoded is HANDLED ============= */
  {
    let s = null;
    try {
      s = await openApp(cdpPort, base, { db: dbOf([trip({ name: 'Own trip', items: [item({ title: 'Mine' })] })]) });
      await gotoHard(s, base + APP + '#share=!!!not-deflate!!!');
      await waitForExpr(s, `document.querySelectorAll('#toasts .toast').length > 0`);
      await t('tp-audit AS-07: a malformed share link says so',
        /could not be opened/i.test(await toastText(s)), await toastText(s), s);
      await t('tp-audit AS-07: the visitor keeps their own trip',
        await evaluate(s, `document.getElementById('board').innerText.includes('Mine')`), '', s);
      // the decode failure is caught and toasted; before this it ALSO escaped as
      // an uncaught promise rejection from the unawaited writer
      await t('tp-audit AS-07: nothing is thrown at the console',
        tpErrors(s).length === 0, tpErrors(s).slice(0, 2).join(' | '), s);
    } catch (e) {
      await t('tp-audit AS-07: block ran', false, String(e && e.message).slice(0, 160), s);
    } finally {
      if (s) try { await closePage(cdpPort, s); } catch { /* gone */ }
    }
  }

  /* ===== CR-03: a selection belongs to the board it was made on =========== */
  freshIds();
  const tripA = trip({
    name: 'Alpha', items: [
      item({ title: 'Alpha museum', startDate: iso(10) }),
      item({ title: 'Alpha lunch', startDate: iso(10), startTime: '12:00' }),
    ],
  });
  const tripB = trip({ name: 'Beta', items: [item({ title: 'Beta shared word museum', startDate: iso(40) })] });
  await withPage('tp-audit CR-03', { db: dbOf([tripA, tripB], tripA.id) }, async (s) => {
    const inSelectMode = () => evaluate(s, `!!document.getElementById('bulkBar') && document.getElementById('selectBtn').getAttribute('aria-pressed') === 'true'`);
    await clickSel(s, '#selectBtn', { settle: 400 });
    await clickSel(s, '#board input[data-sel-id]', { settle: 300 });
    await t('tp-audit CR-03: selection mode is on with one row ticked',
      await inSelectMode() && /1 selected/.test(await evaluate(s, `document.getElementById('bulkCount').textContent`)), '', s);

    // arrive at another trip through the cross-trip search
    await clickSel(s, '#tripSearchBtn', { settle: 300 });
    await setValue(s, '#tripSearchInput', 'museum');
    await evaluate(s, `document.getElementById('tripSearchInput').dispatchEvent(new Event('input',{bubbles:true}))`);
    await waitForExpr(s, `document.querySelectorAll('#tripSearchResults .ts-row').length > 1`);
    await clickSel(s, `#tripSearchResults .ts-row[data-ts-trip="${tripB.id}"]`, { settle: 700 });
    await t('tp-audit CR-03: the search jump switched trips',
      (await readDb(s)).activeTripId === tripB.id, '', s);
    await t('tp-audit CR-03: the bulk bar does not follow the jump',
      !(await inSelectMode()), await evaluate(s, `document.getElementById('bulkCount') ? document.getElementById('bulkCount').textContent : 'no bar'`), s);
    await t('tp-audit CR-03: no stray checkboxes on the new board',
      (await evaluate(s, `document.querySelectorAll('#board input[data-sel-id]').length`)) === 0, '', s);

    // and again through the trip menu's Duplicate, which also lands elsewhere
    await clickSel(s, '#selectBtn', { settle: 400 });
    await clickSel(s, '#board input[data-sel-id]', { settle: 300 });
    await t('tp-audit CR-03: selection mode is on again', await inSelectMode(), '', s);
    await menuAct(s, 'duplicate-trip', 800);
    await t('tp-audit CR-03: a duplicate lands on the copy with no selection',
      !(await inSelectMode()), '', s);
  });

  /* ===== CR-03b: the overlapping-trip warning's link is a trip switch ===== */
  freshIds();
  const overlapA = trip({
    name: 'Overlap A', items: [
      item({ type: 'stay', title: 'A hotel', location: 'Rome', startDate: iso(20), endDate: iso(24) }),
      item({ title: 'A museum', startDate: iso(21) }),
    ],
  });
  const overlapB = trip({
    name: 'Overlap B', items: [
      item({ type: 'stay', title: 'B hotel', location: 'Split', startDate: iso(22), endDate: iso(26) }),
    ],
  });
  await withPage('tp-audit CR-03b', { db: dbOf([overlapA, overlapB], overlapA.id) }, async (s) => {
    await clickSel(s, '#selectBtn', { settle: 400 });
    await clickSel(s, '#board input[data-sel-id]', { settle: 300 });
    await clickSel(s, '#issuesSummary', { settle: 300 });
    const hasLink = await evaluate(s, `!!document.querySelector('#issuesList button[data-trip]')`);
    await t('tp-audit CR-03b: the overlap warning names the other trip', hasLink, '', s);
    if (hasLink) {
      await clickSel(s, '#issuesList button[data-trip]', { settle: 700 });
      await t('tp-audit CR-03b: the link switched trips',
        (await readDb(s)).activeTripId === overlapB.id, '', s);
      await t('tp-audit CR-03b: and dropped the selection with it',
        (await evaluate(s, `!!document.getElementById('bulkBar')`)) === false, '', s);
    }
  });

  /* ===== AS-05: the packing dialog writes to the trip it was opened for === */
  freshIds();
  const packTrip = trip({ name: 'Packing trip', items: [item({ title: 'Something', startDate: iso(15) })] });
  const otherTrip = trip({ name: 'Somewhere else', items: [item({ title: 'Other thing', startDate: iso(60) })] });
  {
    let a = null, b = null;
    try {
      a = await openApp(cdpPort, base, { db: dbOf([packTrip, otherTrip], packTrip.id) });
      b = await openTab(cdpPort, base, {});
      await menuAct(b, 'packing', 700);
      await t('tp-audit AS-05: the packing dialog is open in the second tab',
        (await overlayOpenId(b)) === 'packingOverlay', '', b);

      // the first tab deletes the trip that dialog belongs to
      await menuAct(a, 'delete-trip', 500);
      await clickSel(a, '#confirmYes', { settle: 800 });
      await waitForExpr(a, `JSON.parse(localStorage.getItem('trip-planner:v1')).trips.length === 1`);
      await waitForExpr(b, `JSON.parse(localStorage.getItem('trip-planner:v1')).trips.length === 1`);

      const before = await evaluate(b, `localStorage.getItem('trip-planner:v1')`);
      await setValue(b, '#packingAddInput', 'Socks');
      await evaluate(b, `document.getElementById('packingAddForm').requestSubmit()`);
      await sleep(500);
      await t('tp-audit AS-05: adding a row to a deleted trip says nothing was saved',
        /no longer here/i.test(await toastText(b)), await toastText(b), b);
      await t('tp-audit AS-05: the dialog closes rather than sitting there',
        (await overlayOpenId(b)) !== 'packingOverlay', String(await overlayOpenId(b)), b);
      await t('tp-audit AS-05: storage is untouched by the refused write',
        (await evaluate(b, `localStorage.getItem('trip-planner:v1')`)) === before, '', b);
      await t('tp-audit AS-05: and nothing was thrown',
        tpErrors(b).length === 0, tpErrors(b).slice(0, 2).join(' | '), b);
    } catch (e) {
      await t('tp-audit AS-05: block ran', false, String(e && e.message).slice(0, 160), b || a);
    } finally {
      for (const p of [a, b]) if (p) try { await closePage(cdpPort, p); } catch { /* gone */ }
    }
  }

  /* ===== AS-05b: the dialog keeps editing ITS trip when another is switched to */
  freshIds();
  const pk1 = trip({ name: 'Trip one', items: [item({ title: 'One', startDate: iso(15) })] });
  const pk2 = trip({ name: 'Trip two', items: [item({ title: 'Two', startDate: iso(50) })] });
  {
    let a = null, b = null;
    try {
      a = await openApp(cdpPort, base, { db: dbOf([pk1, pk2], pk1.id) });
      b = await openTab(cdpPort, base, {});
      await menuAct(b, 'packing', 700);
      // the other tab switches the active trip under the open dialog
      await evaluate(a, `(()=>{const s=document.getElementById('tripSelect'); s.value=${JSON.stringify(pk2.id)}; s.dispatchEvent(new Event('change',{bubbles:true})); return 1})()`);
      await waitForExpr(b, `JSON.parse(localStorage.getItem('trip-planner:v1')).activeTripId === ${JSON.stringify(pk2.id)}`);
      await setValue(b, '#packingAddInput', 'Passport holder');
      await evaluate(b, `document.getElementById('packingAddForm').requestSubmit()`);
      await sleep(500);
      const db2 = await readDb(b);
      const one = db2.trips.find(x => x.id === pk1.id);
      const two = db2.trips.find(x => x.id === pk2.id);
      await t('tp-audit AS-05b: the row lands on the trip the dialog was opened for',
        !!one && (one.packing || []).some(r => r.text === 'Passport holder'),
        JSON.stringify((one && one.packing || []).map(r => r.text)), b);
      await t('tp-audit AS-05b: and never on the trip that became active',
        !(two && (two.packing || []).some(r => r.text === 'Passport holder')), '', b);
    } catch (e) {
      await t('tp-audit AS-05b: block ran', false, String(e && e.message).slice(0, 160), b || a);
    } finally {
      for (const p of [a, b]) if (p) try { await closePage(cdpPort, p); } catch { /* gone */ }
    }
  }

  /* ===== DM-05: storage of the wrong shape is repaired, not rendered =====
     A sync peer running older code, a hand edit or a future version can leave a
     number where a string belongs. repairTrips normalized a handful of fields
     and every renderer trusted the rest: `location: 123` emptied the Days view
     ("(it.location || '').trim is not a function"), `startTime: 5` emptied the
     Timeline as well, and neither was repaired or reported. */
  freshIds();
  const badItems = [
    item({ title: 'Numeric place', location: 123, startDate: iso(5), startTime: '09:00' }),
    item({ title: 'Numeric time', location: 'Rome', startDate: iso(5), startTime: 5 }),
    item({ title: 'Numeric ref', location: 'Rome', startDate: iso(6), confirmation: 42 }),
    item({ title: 'Odd fields', location: 'Rome', startDate: iso(6), details: { a: 1 }, costNote: 7, bookBy: 'someday', payment: 9, paidBy: 4, travelers: 'Alex', splitAmounts: [1, 2] }),
    item({ title: 'Bad clock', location: 'Rome', startDate: iso(7), startTime: '99:99', endTime: 'nope' }),
  ];
  const badTrip = trip({ name: 'Wrong shapes', items: badItems });
  badTrip.packing = 'not an array';
  badTrip.essentials = 'not an object';
  badTrip.travelers = 'Alex, Sam';
  await withPage('tp-audit DM-05', { db: dbOf([badTrip]) }, async (s) => {
    await t('tp-audit DM-05: the Timeline draws every row',
      (await evaluate(s, `['Numeric place','Numeric time','Numeric ref','Odd fields','Bad clock'].every(x => document.getElementById('board').innerText.includes(x))`)), '', s);
    await switchView(s, 'days');
    await t('tp-audit DM-05: the Days view draws its cards instead of emptying',
      (await evaluate(s, `document.querySelectorAll('#daysList .day-card').length`)) > 0,
      `cards=${await evaluate(s, `document.querySelectorAll('#daysList .day-card').length`)}`, s);
    const db = await readDb(s);
    const tt = db.trips[0];
    const byTitle = (x) => tt.items.find(i => i.title === x);
    await t('tp-audit DM-05: a numeric place is coerced to text',
      byTitle('Numeric place').location === '123', JSON.stringify(byTitle('Numeric place').location), s);
    await t('tp-audit DM-05: a clock that is not HH:MM is cleared',
      byTitle('Numeric time').startTime === '' && byTitle('Bad clock').startTime === '' && byTitle('Bad clock').endTime === '',
      JSON.stringify([byTitle('Numeric time').startTime, byTitle('Bad clock').startTime, byTitle('Bad clock').endTime]), s);
    await t('tp-audit DM-05: a numeric confirmation becomes its own text',
      byTitle('Numeric ref').confirmation === '42', JSON.stringify(byTitle('Numeric ref').confirmation), s);
    const odd = byTitle('Odd fields');
    await t('tp-audit DM-05: junk booking fields are dropped or coerced',
      typeof odd.details === 'string' && typeof odd.costNote === 'string' && odd.bookBy === ''
      && odd.payment === undefined && odd.paidBy === undefined && odd.travelers === undefined && odd.splitAmounts === undefined,
      JSON.stringify({ d: typeof odd.details, c: typeof odd.costNote, b: odd.bookBy, p: odd.payment, pb: odd.paidBy, tr: odd.travelers, sp: odd.splitAmounts }), s);
    await t('tp-audit DM-05: trip-level stores of the wrong shape are dropped',
      tt.packing === undefined && tt.essentials === undefined && tt.travelers === undefined,
      JSON.stringify({ p: tt.packing, e: tt.essentials, tr: tt.travelers }), s);
    await t('tp-audit DM-05: the packing dialog opens on the repaired trip',
      (await menuAct(s, 'packing', 700), (await overlayOpenId(s)) === 'packingOverlay'), '', s);
    await escape(s);
    await t('tp-audit DM-05: the repair still never arms Undo',
      await evaluate(s, `document.getElementById('undoBtn').disabled`), '', s);
  });

  /* ===== DM-06: a trip with no stay at all reports its uncovered nights === */
  freshIds();
  const stayless = trip({
    name: 'No beds', items: [
      item({ type: 'flight', title: 'Rome (FCO) to Split (SPU)', startDate: iso(20), startTime: '09:00' }),
      item({ title: 'Diocletian Palace', location: 'Split', startDate: iso(22), startTime: '10:00' }),
    ],
  });
  await withPage('tp-audit DM-06', { db: dbOf([stayless]) }, async (s) => {
    await clickSel(s, '#issuesSummary', { settle: 300 });
    const issues = await evaluate(s, `document.getElementById('issuesList').innerText`);
    await t('tp-audit DM-06: the panel names the nights nobody booked',
      /No stay covers/i.test(issues), issues.replace(/\n/g, ' | ').slice(0, 160), s);
    await t('tp-audit DM-06: the night strip is drawn rather than hidden',
      (await evaluate(s, `!document.getElementById('stripBox').hidden && document.querySelectorAll('#strip > *').length === 2`)),
      `cells=${await evaluate(s, `document.querySelectorAll('#strip > *').length`)}`, s);
    await t('tp-audit DM-06: the summary chip and the panel now agree',
      /0 of 2/.test(await evaluate(s, `document.getElementById('summary').innerText`)), '', s);
    // and the warning can act on itself, exactly as a gap between two stays can
    await t('tp-audit DM-06: it offers to add the stay',
      await evaluate(s, `!!document.querySelector('#issuesList button[data-add-stay]')`), '', s);
    await clickSel(s, '#issuesList button[data-add-stay]', { settle: 600 });
    await t('tp-audit DM-06: which opens a stay prefilled with the whole gap',
      await evaluate(s, `document.getElementById('itemOverlay').classList.contains('open')
        && document.querySelector('#typePicker [data-type="stay"]').getAttribute('aria-pressed') === 'true'
        && document.getElementById('inStart').value === ${JSON.stringify(iso(20))}
        && document.getElementById('inEnd').value === ${JSON.stringify(iso(22))}`),
      await evaluate(s, `JSON.stringify([document.getElementById('inStart').value, document.getElementById('inEnd').value])`), s);
    await escape(s);
    // a day trip claims nothing: there is no night to cover
    await evaluate(s, `(()=>{const db=JSON.parse(localStorage.getItem('trip-planner:v1'));
      db.trips[0].items = [db.trips[0].items[0]];
      localStorage.setItem('trip-planner:v1', JSON.stringify(db)); return 1})()`);
    await gotoHard(s, base + APP);
    await t('tp-audit DM-06: a single-day plan raises nothing',
      !/No stay covers/i.test(await evaluate(s, `document.getElementById('issuesBox').innerText`)),
      await evaluate(s, `document.getElementById('issuesBox').innerText.replace(/\\n/g,' ').slice(0,120)`), s);
  });

  /* ===== CR-04: rates that never arrived are not the currency's fault ===== */
  freshIds();
  const foreign = trip({
    name: 'Foreign money', currency: 'USD', items: [
      item({ title: 'Teamlab', location: 'Tokyo', startDate: iso(30), status: 'booked', cost: 3800, costCurrency: 'JPY' }),
    ],
  });
  // the default rule already refuses every external host, so the rate fetch
  // fails exactly as it does offline
  await withPage('tp-audit CR-04', { db: dbOf([foreign]) }, async (s) => {
    await waitForExpr(s, `document.getElementById('issuesBox').innerText.length > 0`);
    await clickSel(s, '#issuesSummary', { settle: 300 });
    const issues = await evaluate(s, `document.getElementById('issuesList').innerText`);
    await t('tp-audit CR-04: the warning blames the missing rates, not the money',
      /rates could not be fetched/i.test(issues) && !/Re-enter/i.test(issues),
      issues.replace(/\n/g, ' | ').slice(0, 200), s);
    await t('tp-audit CR-04: it still names the cost it left out',
      /Teamlab/.test(issues), '', s);
    await t('tp-audit CR-04: and points at the Retry the totals already offer',
      /Retry/i.test(issues) && await evaluate(s, `!!document.getElementById('ratesRetryBtn')`), '', s);
  });

  /* ===== CR-04b: a currency the provider does not quote still says so ===== */
  freshIds();
  const unquoted = trip({
    name: 'Odd currency', currency: 'USD', items: [
      item({ title: 'Souvenirs', location: 'Tbilisi', startDate: iso(30), status: 'booked', cost: 100, costCurrency: 'XXX' }),
    ],
  });
  const ratesOk = (url) => {
    if (/frankfurter/i.test(url)) {
      return { status: 200, body: JSON.stringify({ base: 'USD', date: '2026-08-22', rates: { EUR: 0.9, JPY: 150 } }) };
    }
    return /photon|nominatim|open-meteo|githubusercontent|tile\.openstreetmap|openai|googleapis|gstatic|firebase|\/\.netlify\//i.test(url) ? 'fail' : null;
  };
  await withPage('tp-audit CR-04b', { db: dbOf([unquoted]), net: ratesOk }, async (s) => {
    await waitForExpr(s, `document.getElementById('issuesBox').innerText.includes('warning')`);
    await clickSel(s, '#issuesSummary', { settle: 300 });
    const issues = await evaluate(s, `document.getElementById('issuesList').innerText`);
    await t('tp-audit CR-04b: a live rate table that lacks the code keeps the old advice',
      /No exchange rate for XXX/i.test(issues) && /Re-enter/i.test(issues),
      issues.replace(/\n/g, ' | ').slice(0, 200), s);
  });

  /* ===== CR-02: the trip-delete confirm names what undo cannot bring back = */
  freshIds();
  const docTrip = trip({ name: 'Has papers', items: [item({ id: 'audit-doc-item', title: 'Booked flight', startDate: iso(30) })] });
  await withPage('tp-audit CR-02', { db: dbOf([docTrip]) }, async (s) => {
    // seed the documents pocket directly: the file picker cannot be driven
    const seeded = await evalAsync(s, `(async () => {
      const db = await new Promise((res, rej) => {
        const rq = indexedDB.open('trip-planner-docs', 1);
        rq.onupgradeneeded = () => {
          const st = rq.result.createObjectStore('docs', { keyPath: 'id', autoIncrement: true });
          st.createIndex('byItem', 'itemId');
        };
        rq.onsuccess = () => res(rq.result);
        rq.onerror = () => rej(rq.error);
      });
      await new Promise((res, rej) => {
        const rq = db.transaction('docs', 'readwrite').objectStore('docs')
          .add({ itemId: 'audit-doc-item', name: 'boarding.pdf', type: 'application/pdf', size: 4, blob: new Blob(['pdf!']) });
        rq.onsuccess = () => res(1); rq.onerror = () => rej(rq.error);
      });
      return 1;
    })()`);
    await t('tp-audit CR-02: a document is attached to an item', seeded === 1, String(seeded), s);
    await gotoHard(s, base + APP);
    await waitForExpr(s, `!!document.querySelector('[data-clip-for="audit-doc-item"]:not([hidden])')`);
    await menuAct(s, 'delete-trip', 600);
    const text = await evaluate(s, `document.getElementById('confirmText').textContent`);
    // This assertion used to require the confirm to WARN that attached
    // documents could not be recovered, which was honest while trip delete
    // destroyed them before the undoable save. The 2026-08-22 audit round
    // removed that limitation instead of documenting it: the documents now
    // survive the undo window and are purged at the next boot, so the undo
    // the dialog promises is finally whole. Asserting the old warning would
    // now pin a defect that no longer exists, so this checks the replacement
    // promise: the confirm must still tell the truth about attachments.
    await t('tp-audit CR-02: the confirm says the attachments come back with the trip',
      /Attached documents come back with it/i.test(text), text, s);
    await t('tp-audit CR-02: and still promises the undo it can keep',
      /undo this until you reload/i.test(text), text, s);
    await escape(s);
    // a trip with no attachments says nothing extra, exactly as before
    await evaluate(s, `(()=>{const db=JSON.parse(localStorage.getItem('trip-planner:v1'));
      db.trips[0].items[0].id = 'no-docs-here';
      localStorage.setItem('trip-planner:v1', JSON.stringify(db)); return 1})()`);
    await gotoHard(s, base + APP);
    await menuAct(s, 'delete-trip', 600);
    await t('tp-audit CR-02: a trip with nothing attached keeps the plain wording',
      !/Attached documents/i.test(await evaluate(s, `document.getElementById('confirmText').textContent`)),
      await evaluate(s, `document.getElementById('confirmText').textContent`), s);
    await escape(s);
  });


  /* ===== AS-02 / AS-03 / AS-C1: the assistant mutation chain ===============
     Driven through the Copy & paste tier, which reaches the same
     extract -> validate -> renderProposals -> accept -> save -> undo path a
     live reply takes, with no network and no key. */
  freshIds();
  const booked = item({
    id: 'as-flight', type: 'flight', title: 'Tokyo (HND) to Bangkok (BKK)',
    startDate: iso(30), startTime: '09:00', status: 'booked', cost: 800,
    costCurrency: 'USD', confirmation: 'XJ7K2Q',
  });
  const museum = item({ id: 'as-museum', title: 'Senso-ji', location: 'Tokyo', startDate: iso(29), startTime: '14:00', status: 'to-book' });
  const asTrip = trip({ name: 'Assistant trip', items: [booked, museum] });

  const pasteReply = async (s, text, cards) => {
    await evaluate(s, `(()=>{const r=document.querySelector('#assistTierGroup input[value="copy"]');
      if (r && !r.checked) r.click(); return 1})()`);
    await waitForExpr(s, `!!document.querySelector('#assistPasteBox')`, { timeout: 6000 });
    await setValue(s, '#assistPasteBox', text);
    await clickSel(s, '#assistPasteParse', { settle: 400 });
    return waitForExpr(s, `document.querySelectorAll('#assistMessages .assist-proposal').length === ${cards}`, { timeout: 8000 });
  };
  const itemById = async (s, id) => (await activeTripOf(s)).items.find(x => x.id === id);

  await withPage('tp-audit AS-chain', { db: dbOf([asTrip]) }, async (s) => {
    await clickSel(s, '#assistBtn', { settle: 700 });

    // the package the model is handed carries real ids and no booking facts
    const pkg = await evaluate(s, `JSON.stringify(TripLogic.slimTripForAssistant(
      JSON.parse(localStorage.getItem('trip-planner:v1')).trips[0]))`);
    await t('tp-audit AS-02: the model is given the real item ids',
      pkg.includes('as-flight') && pkg.includes('as-museum'), pkg.slice(0, 120), s);
    await t('tp-audit AS-B3: and no confirmation code',
      !pkg.includes('XJ7K2Q'), '', s);

    // AS-03: an update naming a status must not un-book the flight
    await pasteReply(s, `Moving your flight.
\`\`\`json
{"tripActions":[{"op":"update","match":{"id":"as-flight"},"set":{"startTime":"11:00","status":"to-book"}}]}
\`\`\``, 1);
    await t('tp-audit AS-02: an update by real id renders a card rather than "no matching item"',
      await evaluate(s, `!document.querySelector('#assistMessages .assist-proposal').classList.contains('invalid')`),
      await evaluate(s, `document.querySelector('#assistMessages .assist-proposal').innerText.replace(/\\n/g,' | ').slice(0,140)`), s);
    await clickSel(s, '#assistMessages [data-act="accept-proposal"]', { settle: 800 });
    const flightAfter = await itemById(s, 'as-flight');
    await t('tp-audit AS-03: the booking survives the update',
      flightAfter.status === 'booked' && flightAfter.startTime === '11:00',
      JSON.stringify({ status: flightAfter.status, time: flightAfter.startTime }), s);
    await t('tp-audit AS-03: and so does everything the update did not name',
      flightAfter.cost === 800 && flightAfter.confirmation === 'XJ7K2Q' && flightAfter.title === 'Tokyo (HND) to Bangkok (BKK)',
      JSON.stringify({ cost: flightAfter.cost, conf: flightAfter.confirmation }), s);
    await t('tp-audit AS-03: the Timeline still shows it as Booked',
      await evaluate(s, `[...document.querySelectorAll('#board .tp-row')].some(r => r.innerText.includes('Tokyo (HND)') && r.querySelector('select.status-sel') && r.querySelector('select.status-sel').value === 'booked')`), '', s);
    // undo puts the whole update back
    await ctrlKey(s, 'z', 90);
    await sleep(400);
    const undone = await itemById(s, 'as-flight');
    await t('tp-audit AS-03: undo restores the previous time and keeps the booking',
      undone.startTime === '09:00' && undone.status === 'booked',
      JSON.stringify({ status: undone.status, time: undone.startTime }), s);
    await ctrlKey(s, 'y', 89);
    await sleep(400);
    await t('tp-audit AS-03: redo reapplies it, still booked',
      (await itemById(s, 'as-flight')).startTime === '11:00' && (await itemById(s, 'as-flight')).status === 'booked', '', s);

    // AS-02: a remove by real id, and a made-up id refused
    await pasteReply(s, `Dropping the museum, and one that does not exist.
\`\`\`json
{"tripActions":[{"op":"remove","match":{"id":"as-museum"}},{"op":"update","match":{"id":"i2"},"set":{"startTime":"08:00"}}]}
\`\`\``, 2);
    const cards = await evaluate(s, `[...document.querySelectorAll('#assistMessages .assist-proposal')].map(c => c.classList.contains('invalid') ? 'invalid:' + c.innerText.replace(/\\n/g,' ') : 'valid:' + c.dataset.op).join(' || ')`);
    await t('tp-audit AS-02: the real id removes and the invented "i2" is refused honestly',
      /valid:remove/.test(cards) && /invalid:.*No matching item/i.test(cards), cards.slice(0, 200), s);
    await clickSel(s, '#assistMessages .assist-proposal[data-op="remove"] [data-act="accept-proposal"]', { settle: 800 });
    await t('tp-audit AS-02: accepting the remove deletes exactly that item',
      !(await itemById(s, 'as-museum')) && !!(await itemById(s, 'as-flight')), '', s);
    await ctrlKey(s, 'z', 90);
    await sleep(400);
    await t('tp-audit AS-02: and undo brings it back',
      !!(await itemById(s, 'as-museum')), '', s);

    // AS-C1: a suggestion that is already on the plan
    const dupDate = (await itemById(s, 'as-museum')).startDate;
    await pasteReply(s, `You could visit Senso-ji.
\`\`\`json
{"tripActions":[{"op":"add","item":{"type":"activity","title":"Senso-ji","location":"Tokyo","startDate":"${dupDate}","startTime":"14:00"}}]}
\`\`\``, 1);
    await t('tp-audit AS-C1: a re-suggested item is flagged on the card',
      await evaluate(s, `!!document.querySelector('#assistMessages .ap-dup')`),
      await evaluate(s, `document.querySelector('#assistMessages .assist-proposal').innerText.replace(/\\n/g,' | ').slice(0,140)`), s);
    await t('tp-audit AS-C1: and can still be added, because that is the traveller\'s call',
      await evaluate(s, `!!document.querySelector('#assistMessages [data-act="accept-proposal"]')`), '', s);
  });


  /* ===== DM-02: the visa reminder does not stretch the trip ===============
     It used to be a note DATED thirty days before the trip, which tripStats
     read as the new first day: a 5-day trip became 35 days / 34 nights with
     thirty empty day cards and a countdown to the reminder. */
  freshIds();
  const visaTrip = trip({
    name: 'Bangkok', items: [
      item({ type: 'flight', title: 'London (LHR) to Bangkok (BKK)', startDate: iso(60), startTime: '10:00', status: 'booked' }),
      item({ type: 'stay', title: 'Riverside Hotel', location: 'Bangkok', startDate: iso(61), endDate: iso(65), status: 'booked' }),
    ],
  });
  await withPage('tp-audit DM-02', { db: dbOf([visaTrip]) }, async (s) => {
    const summary = () => evaluate(s, `document.getElementById('summary').innerText.replace(/\\n/g,' | ')`);
    const before = await summary();
    await t('tp-audit DM-02: the trip starts out 6 days long', /6 days/.test(before), before.slice(0, 120), s);

    // the Visas dialog resolves countries through the geocoder, which is
    // blocked here, so the reminder is added through the same call the button
    // makes - the point of this block is what the ITEM does to the trip
    await evaluate(s, `(()=>{ const btn = document.querySelector('[data-remind-cc]'); if (btn) { btn.click(); return 'ui'; } return 'none'; })()`);
    const t0 = await activeTripOf(s);
    await evaluate(s, `(() => {
      const db = JSON.parse(localStorage.getItem('trip-planner:v1'));
      const trip = db.trips[0];
      const start = trip.items.map(i => i.startDate).filter(Boolean).sort()[0];
      trip.items.push({ id: 'visa-reminder', type: 'note', title: 'Apply for Thailand visa',
        location: 'Thailand', status: 'to-book', startDate: start, bookBy: new Date(Date.parse(start) - 30 * 86400000).toISOString().slice(0, 10),
        endDate: '', startTime: '', endTime: '', cost: null, costNote: '', details: '', createdAt: new Date().toISOString() });
      localStorage.setItem('trip-planner:v1', JSON.stringify(db)); return 1; })()`);
    await gotoHard(s, base + APP);
    const after = await summary();
    const field = (txt, key) => (new RegExp(key + ' \\| ([^|]+)').exec(txt) || [null, ''])[1].trim();
    await t('tp-audit DM-02: the reminder leaves the length, dates and countdown alone',
      field(after, 'LENGTH') === field(before, 'LENGTH')
      && field(after, 'DATES') === field(before, 'DATES')
      && field(after, 'COUNTDOWN') === field(before, 'COUNTDOWN'),
      `before: ${field(before, 'DATES')} / ${field(before, 'LENGTH')} vs after: ${field(after, 'DATES')} / ${field(after, 'LENGTH')}`, s);
    await switchView(s, 'days');
    await t('tp-audit DM-02: and adds no empty day cards',
      (await evaluate(s, `document.querySelectorAll('#daysList .day-card').length`)) === 6,
      `cards=${await evaluate(s, `document.querySelectorAll('#daysList .day-card').length`)}`, s);
    await t('tp-audit DM-02: the reminder itself is on the plan with its deadline',
      await evaluate(s, `JSON.parse(localStorage.getItem('trip-planner:v1')).trips[0].items.some(i => i.title === 'Apply for Thailand visa' && !!i.bookBy)`), '', s);
    await t('tp-audit DM-02: no page errors so far', tpErrors(s).length === 0, tpErrors(s).slice(0, 2).join(' | '), s);
    void t0;
  });

  // Switching the display currency flips the symbol IMMEDIATELY but converts
  // only once the rate fetch lands, so the budget chip passes through
  // "€0.00 of $6,000.00-$8,000.00 + 1 not converted": euros in the spent half,
  // dollars still in the ceiling. Waiting for any '€' in #summary let the
  // ceiling assertion run inside that window, which is how this suite flaked
  // in CI on 2026-09-04 (shard 3, "the ceiling is CONVERTED, not relabelled").
  // Wait for the state actually under test instead: the CEILING reading in the
  // new currency, with nothing left unconverted. waitForExpr returns false on
  // timeout rather than throwing, so a conversion that never lands still fails
  // on the assertion below with the real chip text attached.
  const BUDGET_CONVERTED = `(() => {
    const c = [...document.querySelectorAll('#summary .chip')].find(x => /BUDGET/i.test(x.innerText));
    if (!c) return false;
    const txt = c.innerText.replace(/\\n/g, ' ');
    return /of\\s+€/.test(txt) && !/not converted/i.test(txt);
  })()`;

  /* ===== DM-03: the budget keeps its meaning across a currency switch ===== */
  freshIds();
  const budgetTrip = trip({
    name: 'Budgeted', currency: 'USD', budget: 8000, budgetFrom: 6000,
    items: [item({ title: 'Museum', location: 'Rome', startDate: iso(20), status: 'booked', cost: 1000, costCurrency: 'USD' })],
  });
  const ratesNet = (url) => {
    if (/frankfurter/i.test(url)) {
      // 1 USD = 0.9 EUR = 150 JPY, expressed from whichever base is requested:
      // switching the trip currency re-fetches with the new base, and a payload
      // whose base does not match is correctly refused by the app
      const base = (/[?&](?:from|base)=([A-Z]{3})/.exec(url) || [null, 'USD'])[1];
      const perUsd = { USD: 1, EUR: 0.9, JPY: 150 };
      if (!perUsd[base]) return { status: 200, body: JSON.stringify({ base, date: '2026-08-23', rates: {} }) };
      const rates = {};
      for (const [code, v] of Object.entries(perUsd)) if (code !== base) rates[code] = v / perUsd[base];
      return { status: 200, body: JSON.stringify({ base, date: '2026-08-23', rates }) };
    }
    return /photon|nominatim|open-meteo|githubusercontent|tile\.openstreetmap|openai|googleapis|gstatic|firebase|\/\.netlify\//i.test(url) ? 'fail' : null;
  };
  await withPage('tp-audit DM-03', { db: dbOf([budgetTrip]), net: ratesNet }, async (s) => {
    await waitForExpr(s, `document.getElementById('summary').innerText.includes('BUDGET')`);
    const chipOf = () => evaluate(s, `[...document.querySelectorAll('#summary .chip')].map(c => c.innerText.replace(/\\n/g,' ')).find(x => /BUDGET/i.test(x)) || ''`);
    await t('tp-audit DM-03: the budget reads in dollars to start with',
      /\$6,000\.00-\$8,000\.00/.test(await chipOf()), await chipOf(), s);

    // the reported repro: switch the display currency in the totals footer
    await evaluate(s, `(()=>{const sel=document.getElementById('currencySel'); sel.value='EUR'; sel.dispatchEvent(new Event('change',{bubbles:true})); return 1})()`);
    await waitForExpr(s, BUDGET_CONVERTED);
    const eur = await chipOf();
    await t('tp-audit DM-03: the ceiling is CONVERTED, not relabelled',
      /€5,400\.00-€7,200\.00/.test(eur), eur, s);
    await t('tp-audit DM-03: and the stored number keeps the currency it was typed in',
      await evaluate(s, `(()=>{const t=JSON.parse(localStorage.getItem('trip-planner:v1')).trips[0];
        return t.budget === 8000 && t.budgetFrom === 6000 && t.budgetCurrency === 'USD'})()`),
      JSON.stringify((await activeTripOf(s)).budgetCurrency), s);
    // undo puts the switch back
    await ctrlKey(s, 'z', 90);
    await sleep(400);
    await t('tp-audit DM-03: undo restores the dollar reading',
      /\$6,000\.00-\$8,000\.00/.test(await chipOf()), await chipOf(), s);

    // the trip dialog shows the budget in the currency its prefix names
    await evaluate(s, `(()=>{const sel=document.getElementById('currencySel'); sel.value='EUR'; sel.dispatchEvent(new Event('change',{bubbles:true})); return 1})()`);
    await waitForExpr(s, BUDGET_CONVERTED);
    await menuAct(s, 'rename-trip', 600);
    await t('tp-audit DM-03: the dialog opens on the converted figures',
      await evaluate(s, `document.getElementById('inTripBudgetTo').value === '7200' && document.getElementById('inTripBudgetFrom').value === '5400'`),
      await evaluate(s, `JSON.stringify([document.getElementById('inTripBudgetFrom').value, document.getElementById('inTripBudgetTo').value])`), s);
    await t('tp-audit DM-03: with the currency they are in beside them',
      (await evaluate(s, `document.getElementById('tripBudgetPrefix').textContent`)) === '€', '', s);
    await clickSel(s, '#tripSaveBtn', { settle: 700 });
    await t('tp-audit DM-03: saving stores them as euros, with nothing left to convert',
      await evaluate(s, `(()=>{const t=JSON.parse(localStorage.getItem('trip-planner:v1')).trips[0];
        return t.currency === 'EUR' && t.budget === 7200 && t.budgetFrom === 5400 && t.budgetCurrency === undefined})()`),
      JSON.stringify(await activeTripOf(s)).slice(0, 160), s);
    await t('tp-audit DM-03: and the chip still reads the same money',
      /€5,400\.00-€7,200\.00/.test(await chipOf()), await chipOf(), s);
  });

  /* ===== DM-03b: a ceiling no rate can reach is never green ================ */
  freshIds();
  const oddTrip = trip({
    name: 'Odd', currency: 'USD', budget: 100000, budgetCurrency: 'XXX',
    items: [item({ title: 'Thing', startDate: iso(20), status: 'booked', cost: 10, costCurrency: 'USD' })],
  });
  await withPage('tp-audit DM-03b', { db: dbOf([oddTrip]), net: ratesNet }, async (s) => {
    await waitForExpr(s, `document.getElementById('summary').innerText.includes('BUDGET')`);
    const chip = await evaluate(s, `(()=>{const c=[...document.querySelectorAll('#summary .chip')].find(x => /BUDGET/i.test(x.innerText));
      return c ? c.className + '||' + c.innerText.replace(/\\n/g,' ') : ''})()`);
    await t('tp-audit DM-03b: an unreachable ceiling prints in its own currency and is not green',
      /XXX|100,000/.test(chip) && !/ok-chip/.test(chip), chip, s);
  });


  /* ===== HR-01: shut BEFORE opening is not shut AFTER closing ==============
     Reported against the Days view: an activity at 17:30 at a bar open
     18:00-02:00 read "Closed at 5:30 PM · Hours: 6:00 PM-2:00 AM". It had not
     closed; it had not opened, and the traveller needs the hour, not another
     venue. The verdict is a state (beforeOpen) and every surface reads it. */
  freshIds();
  const barDate = iso(12);
  const hoursTrip = trip({
    name: 'Nightlife', items: [
      item({ id: 'hr-early', title: 'Above The Grid', location: 'Bangkok', mapsQuery: 'Above The Grid Bangkok', startDate: barDate, startTime: '17:30', status: 'to-book' }),
      item({ id: 'hr-inside', title: 'Sky Bar', location: 'Bangkok', mapsQuery: 'Sky Bar Bangkok', startDate: barDate, startTime: '20:00', status: 'to-book' }),
      item({ id: 'hr-late', title: 'Dawn Cafe', location: 'Bangkok', mapsQuery: 'Dawn Cafe Bangkok', startDate: barDate, startTime: '23:30', status: 'to-book' }),
    ],
  });
  // Above The Grid and Sky Bar open 18:00-02:00 every day; Dawn Cafe 09:00-17:00.
  // These are the SERVER-normalized shapes the client stores (minutes past
  // midnight, close.day rolled over for an overnight range), not Google's raw
  // hour/minute periods: tp-places normalizes before it answers.
  const dayN = (openMin, closeMin, overnight) => [0, 1, 2, 3, 4, 5, 6].map(d => ({
    open: { day: d, min: openMin }, close: { day: overnight ? (d + 1) % 7 : d, min: closeMin },
  }));
  const NIGHT = { always: false, periods: dayN(18 * 60, 2 * 60, true), special: [] };
  const DAY = { always: false, periods: dayN(9 * 60, 17 * 60, false), special: [] };
  const hoursNet = (url, request) => {
    if (!url.includes('tp-places')) return /photon|nominatim|open-meteo|githubusercontent|tile\.openstreetmap|openai|googleapis|gstatic|firebase|frankfurter/i.test(url) ? 'fail' : null;
    let body = {};
    try { body = JSON.parse(request.postData || '{}'); } catch { /* empty */ }
    // wire entries are { id, q, ... }; the endpoint still accepts bare strings
    const results = (body.queries || []).map(raw => {
      const e = typeof raw === 'string' ? { id: raw, q: raw } : raw;
      return {
        id: e.id, query: e.q, status: 'ok', name: e.q, rating: 4.5, userRatingCount: 900,
        mapsUri: 'https://maps.google.com/?cid=1', confidence: 1, lat: 13.7, lon: 100.5,
        placeId: 'pid-' + e.id, verified: true, areaBasis: 'point',
        hours: /Dawn Cafe/i.test(e.q) ? DAY : NIGHT,
      };
    });
    return { status: 200, body: { results, attribution: { text: 'Google Maps', url: 'https://www.google.com/maps' } } };
  };
  await withPage('tp-audit HR-01', { db: dbOf([hoursTrip]), net: hoursNet }, async (s) => {
    await switchView(s, 'days');
    await waitForExpr(s, `[...document.querySelectorAll('.dc-hours')].filter(e => e.dataset.painted === '1').length >= 3`, { timeout: 12000 });
    // the title cell carries the place chip inline, so rows are matched by
    // substring rather than by an exact key
    const rows = () => evaluate(s, `[...document.querySelectorAll('.dc-event')].map(r => {
      const h = r.querySelector('.dc-hours');
      const ttl = r.querySelector('.dc-title');
      return { title: (ttl ? ttl.textContent : r.textContent).replace(/\\s+/g, ' ').trim(),
        text: h ? h.textContent.trim() : '', verdict: h ? (h.dataset.verdict || '') : '',
        closed: !!(h && h.classList.contains('is-closed')) };
    })`);
    const pick = (list, name) => (list || []).find(r => r.title.includes(name)) || {};
    const r12 = await rows();
    const early = pick(r12, 'Above The Grid');
    await t('tp-audit HR-01: a 17:30 row at an 18:00 bar says it opens at 6:00 PM',
      /Opens at 6:00 PM/.test(early.text) && !/Closed at/.test(early.text) && early.verdict === 'beforeOpen',
      JSON.stringify(early), s);
    await t('tp-audit HR-01: and it still carries the hours it was judged against',
      /6:00 PM/.test(early.text) && /2:00 AM/.test(early.text), early.text, s);
    await t('tp-audit HR-01: a row inside the overnight range is an ordinary open row',
      pick(r12, 'Sky Bar').verdict === 'open' && !/Opens at|Closed at/.test(pick(r12, 'Sky Bar').text || ''),
      JSON.stringify(pick(r12, 'Sky Bar')), s);
    await t('tp-audit HR-01: a row after a venue closes still reads Closed',
      /Closed at 11:30 PM/.test(pick(r12, 'Dawn Cafe').text || '') && pick(r12, 'Dawn Cafe').verdict === 'closed',
      JSON.stringify(pick(r12, 'Dawn Cafe')), s);

    // the same states in 24-hour time
    await menuAct(s, 'timefmt', 600);
    await waitForExpr(s, `[...document.querySelectorAll('.dc-hours')].some(e => /Opens at 18:00/.test(e.textContent))`, { timeout: 8000 });
    const r24 = await rows();
    await t('tp-audit HR-01: the 12/24-hour preference reaches the new wording',
      /Opens at 18:00/.test(pick(r24, 'Above The Grid').text || '')
      && /Closed at 23:30/.test(pick(r24, 'Dawn Cafe').text || ''),
      JSON.stringify({ early: pick(r24, 'Above The Grid'), late: pick(r24, 'Dawn Cafe') }), s);
    await t('tp-audit HR-01: no page errors', tpErrors(s).length === 0, tpErrors(s).slice(0, 2).join(' | '), s);
  });


  /* ===== MV-01: the morning bed, not the night's ==========================
     Check out of Tokyo, take the 10:30 train, check into Kyoto. The 8:00
     breakfast in Ginza was measured from the Kyoto hotel: "~232 mi" on the
     first chip and Directions from the wrong end of the country. */
  freshIds();
  const hDate = iso(25);
  const handoverTrip = trip({
    name: 'Japan handover', items: [
      item({ id: 'mv-tokyo', type: 'stay', title: 'Hotel Ryumeikan Tokyo', location: 'Tokyo', startDate: iso(20), endDate: hDate, status: 'booked' }),
      item({ id: 'mv-break', title: 'Kimuraya Ginza', location: 'Tokyo', mapsQuery: 'Kimuraya Ginza Tokyo', startDate: hDate, startTime: '08:00', status: 'booked' }),
      item({ id: 'mv-train', type: 'transport', title: 'Tokyo to Kyoto', location: 'Kyoto', startDate: hDate, startTime: '10:30', status: 'booked' }),
      item({ id: 'mv-kyoto', type: 'stay', title: 'Hotel Kanra Kyoto', location: 'Kyoto', startDate: hDate, endDate: iso(30), status: 'booked' }),
      item({ id: 'mv-market', title: 'Nishiki Market', location: 'Kyoto', mapsQuery: 'Nishiki Market Kyoto', startDate: hDate, startTime: '15:00', status: 'booked' }),
    ],
  });
  // Coordinates warmed the way the app stores them, so no lookup is needed.
  const mvStores = await (async () => {
    const key = (q) => q; // filled in-page below, where TripLogic is available
    void key;
    return null;
  })();
  void mvStores;
  await withPage('tp-audit MV-01', { db: dbOf([handoverTrip]) }, async (s) => {
    // seed both caches through the app's own key function, then re-boot: the
    // caches are read into closure state exactly once, at load
    await evaluate(s, `(() => {
      const now = Date.now();
      const venue = {};
      // area-aware keys: the city is part of a place's identity now
      const put = (q, city, lat, lon) => { venue[TripLogic.placeCacheKey(q, { city })] = { lat, lon, at: now }; };
      put('Kimuraya Ginza Tokyo', 'Tokyo', 35.672, 139.765);
      put('Nishiki Market Kyoto', 'Kyoto', 35.005, 135.765);
      put('Hotel Ryumeikan Tokyo Tokyo', 'Tokyo', 35.686, 139.774);
      put('Hotel Kanra Kyoto Kyoto', 'Kyoto', 34.996, 135.759);
      localStorage.setItem('trip-planner:venuegeo:v1', JSON.stringify(venue));
      localStorage.setItem('trip-planner:geo:v3', JSON.stringify({
        tokyo: { lat: 35.6762, lon: 139.6503, country: 'Japan', conf: 'confident' },
        kyoto: { lat: 35.0116, lon: 135.7681, country: 'Japan', conf: 'confident' },
      }));
      return 1; })()`);
    await gotoHard(s, base + APP + '#days');
    await waitForExpr(s, `document.querySelectorAll('#daysList .dc-dist').length > 0`, { timeout: 12000 });
    const chips = await evaluate(s, `[...document.querySelectorAll('.dc-event')].map(r => ({
      title: ((r.querySelector('.dc-title') || {}).textContent || '').replace(/\\s+/g, ' ').trim(),
      dist: ((r.querySelector('.dc-dist') || {}).textContent || '').trim(),
      dir: (() => { const a = r.querySelector('[data-dir-type]'); return a ? (a.getAttribute('href') || '') : ''; })(),
    }))`);
    const breakfast = chips.find(c => c.title.includes('Kimuraya')) || {};
    const market = chips.find(c => c.title.includes('Nishiki')) || {};
    const miles = str => { const m = /~([\d.]+)\s*mi\b/.exec(str || ''); return m ? Number(m[1]) : null; };
    // Tokyo-internal either way: the reported bug measured this row at ~232 mi
    // because it started in Kyoto. (The hotel's own coordinate is not seeded
    // here, so the anchor falls back to the Tokyo centroid, which is exactly
    // what a trip whose hotel was typed rather than picked does.)
    await t('tp-audit MV-01: the morning stop is measured inside Tokyo, not from the next city',
      miles(breakfast.dist) !== null && miles(breakfast.dist) < 25,
      JSON.stringify(breakfast), s);
    await t('tp-audit MV-01: and its Directions start at that hotel, not the next city',
      /Ryumeikan|Tokyo/.test(decodeURIComponent(breakfast.dir || '')) && !/Kanra/.test(decodeURIComponent(breakfast.dir || '')),
      decodeURIComponent(breakfast.dir || '').slice(0, 160), s);
    await t('tp-audit MV-01: after the train, Kyoto stops measure from Kyoto',
      miles(market.dist) !== null && miles(market.dist) < 20, JSON.stringify(market), s);
    // the day's own label is a different question from where its chain starts,
    // and it still answers "where is this day": the city it ends in
    const handoverChip = await evaluate(s, `(() => {
      const row = [...document.querySelectorAll('.dc-event')].find(r => /Kimuraya/.test(r.textContent));
      const card = row && row.closest('.day-card');
      const chip = card && card.querySelector('.dc-chip-city');
      return chip ? chip.textContent.trim() : '(no card)'; })()`);
    await t('tp-audit MV-01: the day still belongs to the city it ends in',
      handoverChip === 'Kyoto', handoverChip, s);
    await t('tp-audit MV-01: no page errors', tpErrors(s).length === 0, tpErrors(s).slice(0, 2).join(' | '), s);
  });


  /* ===== the responsive / touch / print batch ============================= */
  freshIds();
  const uiTrip = standardTrip();
  // MV-02: a touch device WIDER than the 900px fold has no hover to reveal
  // the row actions with, and they were opacity 0 with no way to get at them.
  await withPage('tp-audit MV-02', { db: dbOf([uiTrip]), viewport: [1024, 768] }, async (s) => {
    await evaluate(s, `document.querySelectorAll('.tl-toggle[aria-expanded="false"]').forEach(b => b.click())`);
    await sleep(300);
    const state = await evaluate(s, `(() => {
      const el = document.querySelector('#board .c-actions');
      return { hover: matchMedia('(hover: hover) and (pointer: fine)').matches,
        opacity: el ? Number(getComputedStyle(el).opacity) : null,
        buttons: el ? el.querySelectorAll('button').length : 0 };
    })()`);
    await t('tp-audit MV-02: a touch board shows its row actions',
      state.hover === false && state.opacity > 0 && state.buttons >= 3, JSON.stringify(state), s);
    await t('tp-audit MV-02: and they are really clickable there',
      await clickSel(s, '#board .c-actions [data-act="edit"]', { settle: 500 })
        && (await overlayOpenId(s)) === 'itemOverlay', String(await overlayOpenId(s)), s);
    await escape(s);
  });

  // DM-08: a 120-character unbroken title used to push the PAGE sideways
  freshIds();
  const longTrip = trip({ name: 'Long', items: [item({ title: 'A'.repeat(120), location: 'B'.repeat(80), startDate: iso(5) })] });
  await withPage('tp-audit DM-08', { db: dbOf([longTrip]), viewport: [1280, 900] }, async (s) => {
    await t('tp-audit DM-08: an unbreakable title does not scroll the page',
      (await evaluate(s, `document.documentElement.scrollWidth <= document.documentElement.clientWidth`)) === true,
      await evaluate(s, `document.documentElement.scrollWidth + ' vs ' + document.documentElement.clientWidth`), s);
  });

  // MV-03: printing with background graphics off (the browser default)
  await withPage('tp-audit MV-03', { db: dbOf([standardTrip()]), viewport: [1100, 900] }, async (s) => {
    await switchView(s, 'days');
    await s.send('Emulation.setEmulatedMedia', { media: 'print' });
    await sleep(300);
    const read = await evaluate(s, `(() => {
      const lum = rgb => { const m = /(\\d+),\\s*(\\d+),\\s*(\\d+)/.exec(rgb); if (!m) return null;
        const c = [+m[1], +m[2], +m[3]].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
      const ratio = sel => { const e = document.querySelector(sel); if (!e) return null;
        const l = lum(getComputedStyle(e).color); return l == null ? null : (1.05) / (l + 0.05); };
      const header = document.querySelector('#header') || document.querySelector('.tp-page > header');
      return { title: ratio('.dc-title'), when: ratio('.dc-when'), cost: ratio('.dc-cost'),
        bg: getComputedStyle(document.body).backgroundColor,
        header: header ? getComputedStyle(header).display : 'absent' };
    })()`);
    await t('tp-audit MV-03: printed text is readable on white without background graphics',
      read.title > 4.5 && read.when > 4.5 && read.cost > 4.5, JSON.stringify(read), s);
    // the shared header stays: an app stylesheet may not restyle shared chrome
    // (sync-system/tests/shared-ui-consistency.test.mjs), so dropping it from
    // the print sheet is a site-level change, deliberately not made here
    await t('tp-audit MV-03: the day cards themselves carry the print styling',
      (await evaluate(s, `getComputedStyle(document.querySelector('.day-card')).backgroundColor`)) === 'rgb(255, 255, 255)',
      await evaluate(s, `getComputedStyle(document.querySelector('.day-card')).backgroundColor`), s);
    await s.send('Emulation.setEmulatedMedia', { media: '' });
  });

  // AS-04: the panel used to sit on top of Undo, the trip picker and the menu
  await withPage('tp-audit AS-04', { db: dbOf([standardTrip()]), viewport: [1280, 900] }, async (s) => {
    await clickSel(s, '#assistBtn', { settle: 700 });
    const covered = await evaluate(s, `(() => {
      const panel = document.getElementById('assistPanel');
      const check = id => { const b = document.getElementById(id); if (!b) return 'missing';
        const r = b.getBoundingClientRect();
        if (r.width === 0) return 'hidden';
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !top ? 'offscreen' : (panel.contains(top) ? 'COVERED' : 'reachable'); };
      return { undo: check('undoBtn'), picker: check('tripSelect'), menu: check('tripMenuBtn') };
    })()`);
    await t('tp-audit AS-04: the toolbar and trip controls stay reachable with the panel open',
      covered.undo === 'reachable' && covered.picker === 'reachable' && covered.menu === 'reachable',
      JSON.stringify(covered), s);
  });

  // MV-C1: on a phone the chosen view was below the fold
  await withPage('tp-audit MV-C1', { db: dbOf([standardTrip()]), viewport: [390, 844] }, async (s) => {
    await switchView(s, 'days');
    await sleep(400);
    const top = await evaluate(s, `(() => { const c = document.querySelector('#daysList .day-card');
      return c ? Math.round(c.getBoundingClientRect().top) : null; })()`);
    await t('tp-audit MV-C1: tapping Days puts the first card on screen',
      top !== null && top < 844 - 80, `card top ${top} of 844`, s);
  });

  // MV-B1: the day menu says role="menu", so the arrows must work
  await withPage('tp-audit MV-B1', { db: dbOf([standardTrip()]), viewport: [1280, 900] }, async (s) => {
    await switchView(s, 'days');
    await clickSel(s, '#daysList [data-act="day-menu"]', { settle: 400 });
    await evaluate(s, `document.querySelector('.dc-menu:not([hidden]) .dm-item:not([disabled])').focus()`);
    const first = await evaluate(s, `(document.activeElement.textContent || '').trim()`);
    await pressKey(s, 'ArrowDown', 'ArrowDown', 40);
    const second = await evaluate(s, `(document.activeElement.textContent || '').trim()`);
    await pressKey(s, 'End', 'End', 35);
    const last = await evaluate(s, `(document.activeElement.textContent || '').trim()`);
    await t('tp-audit MV-B1: arrows and End move between the menu rows',
      !!first && second !== first && last !== second,
      JSON.stringify({ first, second, last }), s);
    await escape(s);
  });

  // MV-B2: a shared board is read-only, and should look it
  freshIds();
  const ownTrip = trip({ name: 'Mine', items: [item({ title: 'Mine', startDate: iso(3) })] });
  const sharedSrc = trip({ name: 'Friend', items: [item({ title: 'Friend item', startDate: iso(3), status: 'booked' })] });
  {
    let a = null, b = null;
    try {
      a = await openApp(cdpPort, base, { db: dbOf([ownTrip]) });
      const hash = await buildShareHash(a, sharedSrc);
      b = await openTab(cdpPort, base, { hash });
      const el = await evaluate(b, `(() => { const e = document.querySelector('.status-sel');
        return e ? { tag: e.tagName, cls: e.className, text: (e.textContent || '').trim() } : null; })()`);
      await t('tp-audit MV-B2: a shared row states its status instead of offering a picker',
        !!el && el.tag === 'SPAN' && /status-pill/.test(el.cls) && /Booked/i.test(el.text),
        JSON.stringify(el), b);
    } catch (e) {
      await t('tp-audit MV-B2: block ran', false, String(e && e.message).slice(0, 160), b || a);
    } finally {
      for (const p of [a, b]) if (p) try { await closePage(cdpPort, p); } catch { /* gone */ }
    }
  }


  /* ===== provider hygiene: a failure that repeats is a failure per render == */
  freshIds();
  const placesTrip = trip({
    name: 'Providers', items: [
      item({ id: 'pp-live', title: 'Senso-ji', location: 'Tokyo', mapsQuery: 'Senso-ji Tokyo', startDate: iso(9), startTime: '10:00', status: 'to-book' }),
      item({ id: 'pp-dead', title: 'Cancelled thing', location: 'Tokyo', mapsQuery: 'Cancelled thing Tokyo', startDate: iso(9), startTime: '12:00', status: 'cancelled' }),
    ],
  });
  {
    // PP-04: a cancelled row must not reach the billed endpoint
    let s = null;
    const asked = [];
    const spy = (url, request) => {
      if (url.includes('tp-places')) {
        let b = {};
        try { b = JSON.parse(request.postData || '{}'); } catch { /* empty */ }
        // Wire entries are { id, q, city? } now; `asked` keeps the query TEXT
        // so the assertions below still read in venue names.
        const entries = (b.queries || []).map(raw => (typeof raw === 'string' ? { id: raw, q: raw } : raw));
        asked.push(...entries.map(e => e.q));
        return { status: 200, body: { results: entries.map(e => ({ id: e.id, query: e.q, status: 'ok', name: e.q, rating: 4.4, userRatingCount: 10, mapsUri: 'https://maps.google.com/?cid=1', confidence: 1, lat: 35.7, lon: 139.8, placeId: 'pid-' + e.id, verified: true, areaBasis: 'point' })), attribution: { text: 'Google Maps', url: 'https://www.google.com/maps' } } };
      }
      return /photon|nominatim|open-meteo|githubusercontent|tile\.openstreetmap|frankfurter|openai|googleapis|gstatic|firebase/i.test(url) ? 'fail' : null;
    };
    try {
      s = await openApp(cdpPort, base, { db: dbOf([placesTrip]), net: spy });
      await switchView(s, 'days');
      await waitForExpr(s, `[...document.querySelectorAll('.tp-maps-link[data-place-key]')].length >= 1`, { timeout: 8000 });
      await sleep(1200);
      await t('tp-audit PP-04: the live row is looked up',
        asked.some(q => /Senso-ji/i.test(q)), JSON.stringify(asked), s);
      await t('tp-audit PP-04: the cancelled row costs nothing',
        !asked.some(q => /Cancelled thing/i.test(q)), JSON.stringify(asked), s);
      await t('tp-audit PP-04: and it still offers a plain Maps link',
        await evaluate(s, `[...document.querySelectorAll('.tp-maps-link')].some(a => !a.dataset.placeKey && /google\\.com\\/maps/.test(a.href))`), '', s);
    } catch (e) {
      await t('tp-audit PP-04: block ran', false, String(e && e.message).slice(0, 160), s);
    } finally {
      if (s) try { await closePage(cdpPort, s); } catch { /* gone */ }
    }
  }

  {
    // PP-01 / PP-02: an outage costs one request per place per window, not one
    // per consumer and one per render
    let s = null;
    const hits = { geo: 0, weather: 0 };
    const failing = (url) => {
      if (/nominatim/i.test(url)) { hits.geo++; return { status: 500, body: 'nope' }; }
      if (/open-meteo/i.test(url)) { hits.weather++; return { status: 500, body: 'nope' }; }
      return /photon|githubusercontent|tile\.openstreetmap|frankfurter|openai|googleapis|gstatic|firebase|\/\.netlify\//i.test(url) ? 'fail' : null;
    };
    freshIds();
    const outageTrip = trip({
      name: 'Outage', items: [
        item({ id: 'o1', title: 'Museum', location: 'Rome', startDate: iso(8), startTime: '10:00' }),
        item({ id: 'o2', title: 'Gallery', location: 'Florence', startDate: iso(9), startTime: '10:00' }),
      ],
    });
    try {
      s = await openApp(cdpPort, base, { db: dbOf([outageTrip]), net: failing });
      await switchView(s, 'days');
      await sleep(1500);
      const firstWeather = hits.weather;
      // five more renders of the same day grid
      for (let i = 0; i < 5; i++) { await switchView(s, 'timeline'); await switchView(s, 'days'); }
      await sleep(1500);
      await t('tp-audit PP-02: a failed weather lookup is not re-asked on every render',
        hits.weather <= firstWeather + 2, `first render ${firstWeather}, after five more ${hits.weather}`, s);
      // the map, the route dialog and the GPX export all want the same places
      const before = hits.geo;
      await switchView(s, 'map');
      await sleep(2500);
      await switchView(s, 'days');
      await switchView(s, 'map');
      await sleep(2500);
      await t('tp-audit PP-01: a failed place lookup is not re-asked by the next consumer',
        hits.geo <= before + 4, `before the map ${before}, after two map opens ${hits.geo}`, s);
      await t('tp-audit PP-01: and the app says so rather than hanging',
        /could not|offline|hiccup/i.test(await evaluate(s, `document.getElementById('mapStatus').textContent`)),
        await evaluate(s, `document.getElementById('mapStatus').textContent`), s);
      await t('tp-audit PP-01: no page errors during the outage',
        tpErrors(s).length === 0, tpErrors(s).slice(0, 2).join(' | '), s);
    } catch (e) {
      await t('tp-audit PP-01: block ran', false, String(e && e.message).slice(0, 160), s);
    } finally {
      if (s) try { await closePage(cdpPort, s); } catch { /* gone */ }
    }
  }


  /* ===== AS-06 / DM-10: what an import and a repaired db may contain ====== */
  freshIds();
  await withPage('tp-audit AS-06', { db: dbOf([trip({ name: 'Host', items: [item({ title: 'Real', startDate: iso(4) })] })]) }, async (s) => {
    // a share link carrying a date the form itself would refuse
    const hash = await buildShareHash(s, trip({
      name: 'Absurd', items: [
        item({ title: 'Far future', startDate: '9999-12-31' }),
        item({ title: 'Sane', startDate: iso(6), bookBy: '9999-01-01' }),
      ],
    }));
    await gotoHard(s, base + APP + hash);
    await waitForExpr(s, `document.body.classList.contains('tp-shared')`, { timeout: 8000 });
    const shown = await evaluate(s, `document.getElementById('summary').innerText.replace(/\\n/g,' | ')`);
    await t('tp-audit AS-06: an out-of-range date cannot make the summary absurd',
      !/\d{5,} days|\d{5,} nights/.test(shown), shown.slice(0, 160), s);
    await t('tp-audit AS-06: the item survives with the date cleared, and the drop is reported',
      await evaluate(s, `document.getElementById('board').innerText.includes('Far future')`)
      && /lost some values|outside/i.test(await toastText(s)),
      await toastText(s), s);
    await t('tp-audit AS-06: a Book-by outside the range goes the same way',
      await evaluate(s, `(() => {
        const rows = [...document.querySelectorAll('#board .tp-row')];
        return !rows.some(r => /9999/.test(r.textContent)); })()`), '', s);
  });

  // DM-10: two items sharing an id means acting on one acts on the other
  freshIds();
  const twinned = trip({ name: 'Twins', items: [
    item({ id: 'same-id', title: 'First twin', startDate: iso(4) }),
    item({ id: 'same-id', title: 'Second twin', startDate: iso(5) }),
  ] });
  await withPage('tp-audit DM-10', { db: dbOf([twinned]) }, async (s) => {
    const ids = await evaluate(s, `JSON.parse(localStorage.getItem('trip-planner:v1')).trips[0].items.map(i => i.id)`);
    await t('tp-audit DM-10: repair gives the duplicate its own id',
      ids.length === 2 && ids[0] !== ids[1], JSON.stringify(ids), s);
    await t('tp-audit DM-10: and both rows are still there to act on',
      await evaluate(s, `['First twin', 'Second twin'].every(x => document.getElementById('board').innerText.includes(x))`), '', s);
  });

  return R;
}
