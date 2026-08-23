// Trip Planner E2E: share links.
//   I. read-only shared view locks every write path and never touches the
//      visitor's own data
//   J. "Import as my trip" turns the share into ordinary local data
//   Q. XSS: attacker-controlled text renders as text, everywhere
//
// Share links are built with the app's own TripLogic primitives (see
// buildShareHash) so the payload is exactly what shareTrip() would copy,
// without needing clipboard access.
import {
  APP, LS_KEY, recorder, freshIds, iso, item, trip, dbOf, standardTrip,
  openApp, readDb, overlayOpenId, tpErrors, openMenu, menuState,
  addItemViaUi, buildShareHash, expandTimeline, gotoHard,
  closePage, evaluate, clickSel, setValue, pressKey, sleep, waitForExpr,
} from './helpers.mjs';

// Rows the trip menu must keep live on a shared trip. export-gpx is on the
// app's SHARED_MENU_ACTS allowlist too, so shared mode must NOT native-disable
// it; its own two-located-stops readiness gate is expressed as aria-disabled
// (a separate mechanism, asserted separately below) and holds here, where
// geocoding is blocked and nothing can be located.
const SHARED_ALLOWED = ['export-trip', 'export-csv', 'export-ics', 'export-gpx', 'share-trip', 'timefmt'];
const SHARED_BLOCKED = ['new-trip', 'rename-trip', 'duplicate-trip', 'duplicate-template',
  'essentials', 'packing', 'export-all', 'import', 'import-booking', 'delete-trip'];

export async function run({ base, cdpPort }) {
  const R = [];
  const t = recorder(R);

  let s = null;
  try {
    freshIds();
    const ownTrip = standardTrip(30, { name: 'My own plans' });
    const stranger = trip({
      name: 'Strangers weekend',
      items: [
        item({ title: 'Ferry to the island', type: 'transport', startDate: iso(70), startTime: '08:00', status: 'booked', cost: 45, costCurrency: 'USD' }),
        item({ title: 'Harbour hostel', type: 'stay', startDate: iso(70), endDate: iso(72), status: 'to-book', cost: 120, costCurrency: 'USD' }),
        item({ title: 'Cliff walk', startDate: iso(73), startTime: '10:00', status: 'to-book' }),
      ],
    });

    s = await openApp(cdpPort, base, { db: dbOf([ownTrip]) });
    const ownedBytes = await evaluate(s, `localStorage.getItem(${JSON.stringify(LS_KEY)})`);
    const hash = await buildShareHash(s, stranger);
    await t('tp-share I: share hash builds via TripLogic', !!hash, String(hash).slice(0, 60), s);

    /* ------------------ I. read-only shared view ------------------------- */
    await gotoHard(s, base + APP + hash, { settle: 1200 });
    await t('tp-share I: shared banner renders', await evaluate(s, `!!document.getElementById('sharedBanner') && document.getElementById('sharedBanner').innerText.includes('shared copy')`), '', s);
    await t('tp-share I: shared trip renders read-only board', await evaluate(s, `document.getElementById('board').innerText.includes('Cliff walk')`), '', s);
    await t('tp-share I: informational Items chip renders on a share', await evaluate(s, `[...document.querySelectorAll('#summary .chip .v')].some(v=>v.textContent.trim()==='3 items')`), '', s);
    await t('tp-share I: trip picker disabled', await evaluate(s, `document.getElementById('tripSelect').disabled`), '', s);
    await t('tp-share I: cross-trip search hidden', !(await evaluate(s, `(()=>{const b=document.getElementById('tripSearchBtn'); return !!b && b.offsetParent !== null})()`)), '', s);
    await t('tp-share I: Add item unavailable', !(await evaluate(s, `(()=>{const b=document.getElementById('addBtn'); return !!b && b.offsetParent !== null && !b.disabled})()`)), '', s);
    // A disabled <select> still looks pressable (chevron, control shape), so a
    // shared board read as editable until a tap did nothing. There is no picker
    // on a read-only row at all now: the status is stated (MV-B2).
    await t('tp-share I: rows state their status instead of offering a picker', await evaluate(s, `(()=>{
      const p = [...document.querySelectorAll('.status-sel')];
      if (!p.length) return false;
      return p.every(x => x.tagName === 'SPAN' && x.classList.contains('status-pill') && (x.textContent || '').trim().length > 0);
    })()`), '', s);
    await t('tp-share I: and no status control can be operated', await evaluate(s, `!document.querySelector('select[data-status-for]')`), '', s);
    await t('tp-share I: currency picker disabled', await evaluate(s, `(()=>{const c=document.getElementById('currencySel'); return !c || c.disabled})()`), '', s);

    // menu locks are applied when the menu OPENS (FINDINGS), so open it
    await openMenu(s);
    const menu = await menuState(s);
    await t('tp-share I: writing menu rows disabled', SHARED_BLOCKED.every(a => menu[a] === true), JSON.stringify(menu), s);
    await t('tp-share I: export and share rows stay live', SHARED_ALLOWED.every(a => menu[a] === false), JSON.stringify(menu), s);
    // export-gpx: shared mode leaves it live (native disabled=false above),
    // and the separate readiness gate holds because nothing here has a Place.
    // The gate is about the TRIP, not about which views have been opened: the
    // export resolves its own coordinates now (QA TP-21), so the tooltip must
    // never tell the traveller to go and open the Map first.
    const gpx = await evaluate(s, `(()=>{const b=document.querySelector('.tp-menu-panel [data-act="export-gpx"]');
      return b ? { ariaDisabled: b.getAttribute('aria-disabled'), title: b.title } : null})()`);
    await t('tp-share I: export-gpx keeps its own readiness gate on a share',
      !!gpx && gpx.ariaDisabled === 'true' && /two items with a Place/i.test(gpx.title), JSON.stringify(gpx), s);
    await t('tp-share I: and its tooltip does not send you to another view',
      !!gpx && !/open the Map view/i.test(gpx.title), JSON.stringify(gpx), s);
    await pressKey(s, 'Escape', 'Escape', 27);

    // keyboard: "n" must not open Add item; "?" still opens the shortcut list.
    // The "n" claim is NEGATIVE (no overlay may appear), so a fixed beat is
    // the only honest wait; the "?" claim waits on the overlay itself.
    await pressKey(s, 'n', 'KeyN', 78);
    await sleep(300);
    await t('tp-share I: "n" shortcut is inert on a shared trip', (await overlayOpenId(s)) === null, `overlay=${await overlayOpenId(s)}`, s);
    await pressKey(s, '?', 'Slash', 191, 8);
    await waitForExpr(s, `document.getElementById('shortcutsOverlay').classList.contains('open')`, { timeout: 4000 });
    await t('tp-share I: "?" still opens shortcuts for a visitor', (await overlayOpenId(s)) === 'shortcutsOverlay', '', s);
    await pressKey(s, 'Escape', 'Escape', 27);

    const bytesAfterVisit = await evaluate(s, `localStorage.getItem(${JSON.stringify(LS_KEY)})`);
    await t('tp-share I: visiting a share never touches local data', bytesAfterVisit === ownedBytes, '', s);

    /* -------------------- J. import as my trip --------------------------- */
    await clickSel(s, '#sharedImport', { settle: 900 });
    let db = await readDb(s);
    const imported = db.trips.find(x => x.name === 'Strangers weekend');
    await t('tp-share J: import lands the trip in local data', !!imported && imported.items.length === 3, JSON.stringify(db.trips.map(x => x.name)), s);
    await t('tp-share J: import keeps the owner trips intact', !!db.trips.find(x => x.name === 'My own plans'), '', s);
    await t('tp-share J: imported trip becomes the active one', db.activeTripId === imported.id, '', s);
    await t('tp-share J: share fragment cleared after import', await evaluate(s, `!location.hash.toLowerCase().includes('share=')`), '', s);
    await t('tp-share J: imported trip is editable', await evaluate(s, `(()=>{const b=document.getElementById('addBtn'); return !!b && b.offsetParent !== null && !b.disabled})()`), '', s);
    await addItemViaUi(s, { type: 'note', title: 'My note on their plan', start: iso(71) });
    db = await readDb(s);
    await t('tp-share J: edits to the import save normally', db.trips.find(x => x.id === imported.id).items.some(x => x.title === 'My note on their plan'), '', s);

    await gotoHard(s, base + APP, { settle: 900 });
    db = await readDb(s);
    await t('tp-share J: import survives a reload', !!db.trips.find(x => x.name === 'Strangers weekend') && db.trips.find(x => x.name === 'Strangers weekend').items.length === 4, '', s);

    // the link itself was never mutated: opening it again still shows the
    // stranger's original three items, not the visitor's edits
    await gotoHard(s, base + APP + hash, { settle: 1200 });
    await t('tp-share J: the shared representation itself is unchanged', await evaluate(s, `document.getElementById('board').innerText.includes('Cliff walk') && !document.getElementById('board').innerText.includes('My note on their plan')`), '', s);
    await t('tp-share I/J: no page errors', tpErrors(s).length === 0, tpErrors(s).slice(0, 2).join(' | '), s);
  } catch (e) {
    await t('tp-share I/J: block ran', false, String(e && e.message).slice(0, 140), s);
  } finally {
    if (s) try { await closePage(cdpPort, s); } catch { /* gone */ }
  }

  /* --------------------- Q. XSS / unsafe rendering ----------------------- */
  let sx = null;
  try {
    freshIds();
    const P = `<img src=x onerror="window.__xss=1">`;
    const evil = trip({
      name: `Evil ${P} trip`,
      items: [
        item({ title: `Dinner ${P}`, location: `Osaka ${P}`, details: `Bring cash ${P} https://example.com`, confirmation: 'REF<img src=x onerror="window.__xss=2">', startDate: iso(30), startTime: '19:00' }),
        item({ type: 'stay', title: `Hotel ${P}`, startDate: iso(30), endDate: iso(31), costNote: `Included ${P}` }),
      ],
    });
    sx = await openApp(cdpPort, base, { db: dbOf([evil]) });
    await expandTimeline(sx);
    await evaluate(sx, `document.getElementById('searchBox').focus()`);
    // sequencing waits only: this block exercises the search render paths
    // with hostile text, so the condition is "the filtered board is drawn"
    // (a stay whose child matches keeps its wrapper row, so no !Hotel clause)
    await setValue(sx, '#searchBox', 'Dinner');
    await waitForExpr(sx, `[...document.querySelectorAll('#board .tp-row .c-title')].some(e=>e.textContent.includes('Dinner'))`, { timeout: 6000 });
    await setValue(sx, '#searchBox', '');
    await waitForExpr(sx, `[...document.querySelectorAll('#board .tp-row .c-title')].some(e=>e.textContent.includes('Hotel'))`, { timeout: 6000 });
    await clickSel(sx, '#viewDays', { settle: 900 });
    const fired = await evaluate(sx, `window.__xss`);
    await t('tp-share Q: seeded payloads never execute', fired == null, `__xss=${fired}`, sx);
    await t('tp-share Q: payload renders as literal text', await evaluate(sx, `document.body.innerText.includes('<img src=x')`), '', sx);

    // typed-in pathway: the same payload entered through the real form
    await clickSel(sx, '#viewTimeline', { settle: 600 });
    await addItemViaUi(sx, { type: 'activity', title: `Typed ${P}`, start: iso(31), time: '09:00' });
    await expandTimeline(sx);
    const fired2 = await evaluate(sx, `window.__xss`);
    await t('tp-share Q: typed payload never executes', fired2 == null, `__xss=${fired2}`, sx);

    // shared-view pathway: banner + board render a hostile trip name safely
    const hash = await buildShareHash(sx, evil);
    await gotoHard(sx, base + APP + hash, { settle: 1200 });
    const fired3 = await evaluate(sx, `window.__xss`);
    await t('tp-share Q: shared view renders hostile trip safely', fired3 == null
      && await evaluate(sx, `!!document.getElementById('sharedBanner')`), `__xss=${fired3}`, sx);
    await t('tp-share Q: no page errors', tpErrors(sx).length === 0, tpErrors(sx).slice(0, 2).join(' | '), sx);
  } catch (e) {
    await t('tp-share Q: block ran', false, String(e && e.message).slice(0, 140), sx);
  } finally {
    if (sx) try { await closePage(cdpPort, sx); } catch { /* gone */ }
  }

  return R;
}
