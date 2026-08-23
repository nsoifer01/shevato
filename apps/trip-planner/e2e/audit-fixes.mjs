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
import {
  APP, recorder, freshIds, iso, item, trip, dbOf,
  openApp, openTab, readDb, activeTripOf, tpErrors, closePage, evaluate, evalAsync, waitForExpr,
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
    await t('tp-audit CR-02: the confirm says the attachments cannot come back',
      /Attached documents cannot be recovered/i.test(text), text, s);
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

  return R;
}
