// Trip Planner E2E: multiple trips, stale-dialog guards, same-device tabs.
//   F. two trips: switching, edits staying attached to the right trip
//   G. stale dialogs vs external reconciliation (the wrong-trip bug class):
//      a Trip-settings or item dialog opened on one state must never mutate
//      whatever trip/item is active by the time Save is pressed
//   H. multi-tab storage synchronization (the native `storage` listener)
//
// G and H drive the SECOND tab as the external writer, which is exactly the
// reconciliation pathway the guards exist for (same handling as a remote
// merge; see FINDINGS "Sync model").
import {
  recorder, freshIds, iso, item, trip, dbOf, standardTrip,
  openApp, openTab, readDb, overlayOpenId, toastText, tpErrors,
  menuAct, addItemViaUi, fillItem, expandTimeline,
  closePage, evaluate, clickSel, setValue, sleep, waitForExpr,
} from './helpers.mjs';

export async function run({ base, cdpPort }) {
  const R = [];
  const t = recorder(R);

  /* ------------------- F. edits stick to the right trip ------------------ */
  try {
    freshIds();
    const tripA = trip({ name: 'Trip Alpha', items: [item({ title: 'Alpha base camp', type: 'stay', startDate: iso(20), endDate: iso(22) })] });
    const tripB = trip({ name: 'Trip Beta', items: [item({ title: 'Beta kickoff', startDate: iso(50), startTime: '09:00' })] });
    const s = await openApp(cdpPort, base, { db: dbOf([tripA, tripB], tripA.id) });

    await t('tp-trips F: picker lists both trips', await evaluate(s, `document.getElementById('tripSelect').options.length`) === 2, '', s);
    await t('tp-trips F: board shows the active trip', await evaluate(s, `document.getElementById('board').innerText.includes('Alpha base camp')`), '', s);

    await addItemViaUi(s, { type: 'activity', title: 'Added on Alpha', start: iso(21), time: '11:00' });
    let db = await readDb(s);
    await t('tp-trips F: add lands on the active trip only',
      db.trips.find(x => x.id === tripA.id).items.some(x => x.title === 'Added on Alpha')
      && !db.trips.find(x => x.id === tripB.id).items.some(x => x.title === 'Added on Alpha'), '', s);

    await setValue(s, '#tripSelect', tripB.id);
    await sleep(700);
    await t('tp-trips F: switching renders the other trip', await evaluate(s, `document.getElementById('board').innerText.includes('Beta kickoff') && !document.getElementById('board').innerText.includes('Alpha base camp')`), '', s);
    db = await readDb(s);
    await t('tp-trips F: switch persists as the active trip', db.activeTripId === tripB.id, '', s);

    await addItemViaUi(s, { type: 'note', title: 'Added on Beta', start: iso(51) });
    db = await readDb(s);
    const a = db.trips.find(x => x.id === tripA.id), b = db.trips.find(x => x.id === tripB.id);
    await t('tp-trips F: second add lands on the switched-to trip only',
      b.items.some(x => x.title === 'Added on Beta') && !a.items.some(x => x.title === 'Added on Beta'), '', s);
    await t('tp-trips F: trip A kept exactly its own items', a.items.length === 2 && b.items.length === 2,
      `A=${a.items.length} B=${b.items.length}`, s);
    await t('tp-trips F: no page errors', tpErrors(s).length === 0, tpErrors(s).slice(0, 2).join(' | '), s);
    await closePage(cdpPort, s);
  } catch (e) { await t('tp-trips F: block ran', false, String(e && e.message).slice(0, 140)); }

  /* ---------- G + H. two tabs: reconciliation and stale dialogs ---------- */
  let s1 = null, s2 = null;
  try {
    freshIds();
    const tripA = standardTrip(30, { name: 'Trip Alpha' });
    const tripB = trip({ name: 'Trip Beta', items: [item({ title: 'Beta kickoff', startDate: iso(50), startTime: '09:00' })] });
    s1 = await openApp(cdpPort, base, { db: dbOf([tripA, tripB], tripA.id) });
    s2 = await openTab(cdpPort, base);

    /* H: a save in one tab reconciles the other */
    await addItemViaUi(s1, { type: 'activity', title: 'Cross-tab ramen', start: iso(40), time: '13:00' });
    const sawIt = await waitForExpr(s2, `document.getElementById('board').innerText.includes('Cross-tab ramen')`, { timeout: 6000 });
    await t('tp-trips H: tab B re-renders after a save in tab A', sawIt, '', s2);
    await t('tp-trips H: tab B history resets on reconcile (undo disabled)',
      await evaluate(s2, `document.getElementById('undoBtn').disabled`), '', s2);

    // and the other direction: a write in tab B reaches tab A
    await expandTimeline(s2);
    const ramenId = (await readDb(s2)).trips.find(x => x.id === tripA.id).items.find(x => x.title === 'Cross-tab ramen').id;
    await setValue(s2, `.tp-row[data-id="${ramenId}"] .status-sel`, 'booked');
    const sawBack = await waitForExpr(s1, `(()=>{ const r=document.querySelector('.tp-row[data-id="${ramenId}"] .status-sel'); return r && r.value === 'booked' })()`, { timeout: 6000 });
    await t('tp-trips H: tab A re-renders after a save in tab B', sawBack, '', s1);

    /* G1: settings dialog opened on Alpha; active trip switched to Beta
       externally; Save must edit Alpha, never Beta */
    await menuAct(s1, 'rename-trip');
    await t('tp-trips G: Trip settings opens', (await overlayOpenId(s1)) === 'tripOverlay', '', s1);
    await setValue(s2, '#tripSelect', tripB.id); // external switch while the dialog is open
    await waitForExpr(s1, `document.getElementById('tripSelect').value === ${JSON.stringify(tripB.id)}`, { timeout: 6000 });
    await setValue(s1, '#inTripName', 'Alpha renamed');
    await clickSel(s1, '#tripSaveBtn', { settle: 800 });
    let db = await readDb(s1);
    await t('tp-trips G: stale settings dialog edits the trip it was opened on',
      db.trips.find(x => x.id === tripA.id).name === 'Alpha renamed', JSON.stringify(db.trips.map(x => x.name)), s1);
    await t('tp-trips G: ...and never the trip that became active meanwhile',
      db.trips.find(x => x.id === tripB.id).name === 'Trip Beta', JSON.stringify(db.trips.map(x => x.name)), s1);

    /* G2: item edit dialog open while the item is deleted externally */
    await setValue(s1, '#tripSelect', tripA.id);
    await sleep(600);
    await expandTimeline(s1);
    await clickSel(s1, `.tp-row[data-id="${ramenId}"] [data-act="edit"]`, { settle: 500 });
    await t('tp-trips G: item edit dialog opens', (await overlayOpenId(s1)) === 'itemOverlay', '', s1);
    // external delete in tab 2 (tab 2 is parked on Beta; move it back first)
    await setValue(s2, '#tripSelect', tripA.id);
    await sleep(600);
    await expandTimeline(s2);
    await clickSel(s2, `.tp-row[data-id="${ramenId}"] [data-act="delete"]`, { settle: 700 });
    await waitForExpr(s1, `!JSON.parse(localStorage.getItem('trip-planner:v1')).trips.find(x=>x.id===${JSON.stringify(tripA.id)}).items.some(x=>x.id===${JSON.stringify(ramenId)})`, { timeout: 6000 });
    await fillItem(s1, { title: 'Zombie ramen' });
    await clickSel(s1, '#itemSaveBtn', { settle: 800 });
    db = await readDb(s1);
    await t('tp-trips G: saving an edit of an externally deleted item resurrects nothing',
      !db.trips.find(x => x.id === tripA.id).items.some(x => x.id === ramenId || x.title === 'Zombie ramen'), '', s1);
    await t('tp-trips G: ...and says so out loud', /no longer/i.test(await toastText(s1) || ''), await toastText(s1), s1);

    /* G3: settings dialog open while the trip itself is deleted externally */
    await menuAct(s1, 'rename-trip'); // settings on Alpha (active in tab 1)
    await setValue(s2, '#tripSelect', tripA.id).catch(() => {});
    await menuAct(s2, 'delete-trip');
    await clickSel(s2, '#confirmYes', { settle: 800 });
    await waitForExpr(s1, `!JSON.parse(localStorage.getItem('trip-planner:v1')).trips.some(x=>x.id===${JSON.stringify(tripA.id)})`, { timeout: 6000 });
    await setValue(s1, '#inTripName', 'Ghost trip');
    await clickSel(s1, '#tripSaveBtn', { settle: 800 });
    db = await readDb(s1);
    await t('tp-trips G: saving settings of an externally deleted trip mutates nothing',
      !db.trips.some(x => x.name === 'Ghost trip') && db.trips.find(x => x.id === tripB.id).name === 'Trip Beta',
      JSON.stringify(db.trips.map(x => x.name)), s1);
    await t('tp-trips G: ...and reports the trip is gone', /no longer/i.test(await toastText(s1) || ''), await toastText(s1), s1);

    await t('tp-trips G/H: no page errors in tab A', tpErrors(s1).length === 0, tpErrors(s1).slice(0, 2).join(' | '), s1);
    await t('tp-trips G/H: no page errors in tab B', tpErrors(s2).length === 0, tpErrors(s2).slice(0, 2).join(' | '), s2);
  } catch (e) {
    await t('tp-trips G/H: block ran', false, String(e && e.message).slice(0, 140), s1);
  } finally {
    if (s1) try { await closePage(cdpPort, s1); } catch { /* gone */ }
    if (s2) try { await closePage(cdpPort, s2); } catch { /* gone */ }
  }

  return R;
}
