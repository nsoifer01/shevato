// Trip Planner E2E: interaction chrome.
//   M. dialog mechanics (Escape, backdrop, focus trap, focus return,
//      layer-at-a-time closing, background isolation)
//   N. keyboard shortcuts and their editable-field guards
//   P. responsive smoke at desktop and phone widths
//
// The app has ~10 dialogs sharing one overlay mechanism; M tests the shared
// mechanism plus representative dialogs rather than every modal separately.
import {
  recorder, freshIds, dbOf, standardTrip, trip, item, iso,
  openApp, readDb, overlayOpenId, tpErrors, openAddItem,
  switchView, escape, closePage, evaluate,
  clickSel, pressKey, sleep, setValue, waitForExpr,
} from './helpers.mjs';
import { clickAt, typeInto, EXTERNAL_HOSTS } from '../../../tests/browser/cdp.mjs';

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
      await t(`${label}: block ran`, false, String(e && e.message).slice(0, 140), s);
    } finally {
      if (s) try { await closePage(cdpPort, s); } catch { /* gone */ }
    }
  };

  /* ----------------------- M. dialog mechanics --------------------------- */
  freshIds();
  const seedM = standardTrip();
  await withPage('tp-ui M', { db: dbOf([seedM]) }, async (s) => {
    // Escape closes, focus returns to the opener
    await openAddItem(s);
    await escape(s);
    await waitForExpr(s, `!document.querySelector('.overlay.open')`, { timeout: 4000 });
    await t('tp-ui M: Escape closes a dialog', (await overlayOpenId(s)) === null, '', s);
    await t('tp-ui M: focus returns to the opener', (await evaluate(s, `document.activeElement && document.activeElement.id`)) === 'addBtn', '', s);

    // backdrop closes, and the click never reaches controls behind the overlay
    await openAddItem(s);
    const undoDisabledBefore = await evaluate(s, `document.getElementById('undoBtn').disabled`);
    const box = await evaluate(s, `(()=>{const r=document.getElementById('undoBtn').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    await clickAt(s, box.x, box.y); // lands on the backdrop covering the toolbar
    await waitForExpr(s, `!document.querySelector('.overlay.open')`, { timeout: 4000 });
    await t('tp-ui M: backdrop click closes the dialog', (await overlayOpenId(s)) === null, '', s);
    const items = (await readDb(s)).trips[0].items.length;
    await t('tp-ui M: the backdrop click never reaches the page behind', items === seedM.items.length
      && (await evaluate(s, `document.getElementById('undoBtn').disabled`)) === undoDisabledBefore, `items=${items}`, s);

    // focus trap: Tab cycles inside the open dialog, never out of it
    await openAddItem(s);
    let trapped = true;
    for (let i = 0; i < 15; i++) {
      await pressKey(s, 'Tab', 'Tab', 9);
      if (!(await evaluate(s, `document.getElementById('itemOverlay').contains(document.activeElement)`))) { trapped = false; break; }
    }
    await t('tp-ui M: Tab is trapped inside the dialog', trapped, '', s);
    await pressKey(s, 'Tab', 'Tab', 9, 8); // shift+tab wraps backwards too
    await t('tp-ui M: Shift+Tab stays trapped too', await evaluate(s, `document.getElementById('itemOverlay').contains(document.activeElement)`), '', s);
    await escape(s);

    // layers close one at a time, topmost first: dialog, then assistant panel,
    // then the trip menu (the documented Escape order)
    await clickSel(s, '#assistBtn', { settle: 600 });
    await t('tp-ui M: assistant panel opens', !(await evaluate(s, `document.getElementById('assistPanel').hidden`)), '', s);
    // the panel overlays the toolbar's ? button, so stack the dialog via the ?
    // KEY; the panel focuses its composer on open, so blur first or the typed
    // ? correctly reaches the textarea instead
    await evaluate(s, `(()=>{ if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return 1 })()`);
    await pressKey(s, '?', 'Slash', 191, 8);
    await waitForExpr(s, `document.getElementById('shortcutsOverlay').classList.contains('open')`, { timeout: 4000 });
    await t('tp-ui M: dialog stacks over the panel', (await overlayOpenId(s)) === 'shortcutsOverlay', '', s);
    await escape(s);
    await t('tp-ui M: first Escape closes only the dialog', (await overlayOpenId(s)) === null
      && !(await evaluate(s, `document.getElementById('assistPanel').hidden`)), '', s);
    await escape(s);
    await t('tp-ui M: second Escape closes the panel', await evaluate(s, `document.getElementById('assistPanel').hidden`), '', s);
    await clickSel(s, '#tripMenuBtn', { settle: 300 });
    await escape(s);
    await t('tp-ui M: Escape closes the trip menu', !(await evaluate(s, `document.getElementById('tripMenu').classList.contains('open')`)), '', s);
  });

  /* --------------------- N. keyboard shortcuts --------------------------- */
  freshIds();
  const seedN = standardTrip();
  await withPage('tp-ui N', { db: dbOf([seedN]) }, async (s) => {
    // n opens Add item (Ctrl+Z / Ctrl+Y are covered in tp-core D)
    await pressKey(s, 'n', 'KeyN', 78);
    await waitForExpr(s, `document.getElementById('itemOverlay').classList.contains('open')`, { timeout: 4000 });
    await t('tp-ui N: "n" opens Add item', (await overlayOpenId(s)) === 'itemOverlay', '', s);
    await escape(s);

    // ? opens the shortcut list, Escape closes it, focus comes back
    await clickSel(s, '#shortcutsBtn', { settle: 400 });
    await t('tp-ui N: the ? button opens the shortcut list', (await overlayOpenId(s)) === 'shortcutsOverlay', '', s);
    await escape(s);
    await t('tp-ui N: focus returns to the ? button', (await evaluate(s, `document.activeElement && document.activeElement.id`)) === 'shortcutsBtn', '', s);
    await pressKey(s, '?', 'Slash', 191, 8);
    await waitForExpr(s, `document.getElementById('shortcutsOverlay').classList.contains('open')`, { timeout: 4000 });
    await t('tp-ui N: the ? key opens the list too', (await overlayOpenId(s)) === 'shortcutsOverlay', '', s);
    await escape(s);

    // shortcut keys typed into editable controls must reach the control.
    // These two are NEGATIVE claims (the overlay must NOT open), so there is
    // no observable condition to wait on: a fixed beat is the only honest
    // wait, long enough that a wrongly-triggered overlay would have opened.
    await clickSel(s, '#searchBox', { settle: 200 });
    await pressKey(s, 'n', 'KeyN', 78);
    await sleep(300);
    await t('tp-ui N: "n" inside a text field is not a shortcut', (await overlayOpenId(s)) === null, `overlay=${await overlayOpenId(s)}`, s);
    await pressKey(s, '?', 'Slash', 191, 8);
    await sleep(300);
    await t('tp-ui N: "?" inside a text field is not a shortcut', (await overlayOpenId(s)) === null, '', s);
  });

  /* ----------------------- P. responsive smoke --------------------------- */
  for (const [w, h, name] of [[1280, 900, 'desktop 1280'], [390, 844, 'phone 390'], [360, 780, 'phone 360']]) {
    freshIds();
    const seedP = standardTrip();
    await withPage(`tp-ui P ${name}`, { db: dbOf([seedP]), viewport: [w, h] }, async (s) => {
      const overflow = () => evaluate(s, `document.documentElement.scrollWidth - window.innerWidth`);
      await t(`tp-ui P ${name}: no horizontal overflow on the timeline`, (await overflow()) <= 1, `overflow=${await overflow()}px`, s);
      await t(`tp-ui P ${name}: primary controls visible`, await evaluate(s, `(()=>{const ids=['addBtn','viewTimeline','viewDays','tripMenuBtn']; return ids.every(id=>{const e=document.getElementById(id); return e && e.offsetParent !== null})})()`), '', s);

      // the add dialog fits and its Save button is genuinely hittable
      await openAddItem(s);
      const modal = await evaluate(s, `(()=>{const m=document.querySelector('#itemOverlay .modal'); const r=m.getBoundingClientRect(); return {left:r.left, right:r.right, w:r.width}})()`);
      await t(`tp-ui P ${name}: dialog fits the viewport width`, modal.left >= -1 && modal.right <= w + 1, JSON.stringify(modal), s);
      const save = await evaluate(s, `(()=>{const b=document.getElementById('itemSaveBtn'); b.scrollIntoView({block:'center'}); const r=b.getBoundingClientRect();
        const hit=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2); return {x:r.left+r.width/2, y:r.top+r.height/2, inView: r.left>=0 && r.right<=window.innerWidth, hits: !!hit && (hit===b || b.contains(hit))}})()`);
      await t(`tp-ui P ${name}: Save is on screen and hit-testable`, save.inView && save.hits, JSON.stringify(save), s);
      await escape(s);

      // Days view stays usable
      await switchView(s, 'days');
      await t(`tp-ui P ${name}: no horizontal overflow in Days view`, (await overflow()) <= 1, `overflow=${await overflow()}px`, s);
      await t(`tp-ui P ${name}: day cards fit their column`, await evaluate(s, `[...document.querySelectorAll('.day-card')].every(c=>{const r=c.getBoundingClientRect(); return r.width <= window.innerWidth + 1})`), '', s);
    });
  }

  /* -------------- H. hotel picker (the stay-only title combobox) --------- */
  // Photon is canned through the net rule, so this pins the real wire-to-DOM
  // path: ranked rows (the Place-field city beating Photon's own order, the
  // exact case FINDINGS documents as "novotel + Bangkok answers Bangkok, not
  // Christchurch"), the lodging-only filter, and a pick seeding the geocode
  // cache with the HOTEL's coordinates rather than the city centroid.
  const PHOTON_OK = {
    features: [
      // Photon's own order puts Christchurch first: the city bonus must beat it
      { properties: { name: 'Novotel Christchurch Cathedral Square', osm_key: 'tourism', osm_value: 'hotel', city: 'Christchurch', country: 'New Zealand', countrycode: 'NZ' }, geometry: { coordinates: [172.6366, -43.5309] } },
      { properties: { name: 'Novotel Bangkok Sukhumvit', osm_key: 'tourism', osm_value: 'hotel', city: 'Bangkok', country: 'Thailand', countrycode: 'TH' }, geometry: { coordinates: [100.5600, 13.7390] } },
      { properties: { name: 'Novotel Residences Bangkok', osm_key: 'tourism', osm_value: 'apartment', city: 'Bangkok', country: 'Thailand', countrycode: 'TH' }, geometry: { coordinates: [100.5500, 13.7300] } },
      // the osm_tag filter is a request, not a guarantee: this must be dropped
      { properties: { name: 'Novotel Noodle Bar', osm_key: 'amenity', osm_value: 'restaurant', city: 'Bangkok', country: 'Thailand', countrycode: 'TH' }, geometry: { coordinates: [100.5000, 13.7000] } },
    ],
  };
  freshIds();
  const seedH = trip({ name: 'Hotel picker trip', items: [item({ title: 'Existing plan', startDate: iso(30), startTime: '10:00' })] });
  let photonCalls = 0;
  const photonNet = (url) => {
    if (/photon\.komoot\.io/i.test(url)) { photonCalls += 1; return { status: 200, body: PHOTON_OK }; }
    return EXTERNAL_HOSTS.test(url) ? 'fail' : null;
  };
  await withPage('tp-ui H', { db: dbOf([seedH]), net: photonNet }, async (s) => {
    const visiblePop = `[...document.querySelectorAll('.cb-pop')].find(x=>!x.hidden)`;
    await openAddItem(s);
    await clickSel(s, '#typePicker [data-type="stay"]', { settle: 300 });
    await setValue(s, '#inLocation', 'Bangkok');
    await typeInto(s, '#inTitle', 'novotel');
    const open = await waitForExpr(s, `(()=>{const p=${visiblePop}; return !!p && p.children.length>0})()`, { timeout: 6000 });
    const rows = await evaluate(s, `(()=>{const p=${visiblePop}; return p ? [...p.children].map(o=>({
      main:(o.querySelector('.cb-main')||{}).textContent||'', tag:(o.querySelector('.cb-tag')||{}).textContent||''})) : []})()`);
    await t('tp-ui H: typing a stay title shows ranked lodging suggestions', open && rows.length === 3, JSON.stringify(rows), s);
    await t('tp-ui H: the Place-field city outranks Photon order',
      rows.length > 0 && rows[0].main === 'Novotel Bangkok Sukhumvit' && rows[0].tag === 'Hotel', JSON.stringify(rows[0] || null), s);
    await t('tp-ui H: non-lodging rows never reach the hotel field',
      rows.every(r => !r.main.includes('Noodle Bar')), JSON.stringify(rows), s);

    await clickSel(s, '.cb-pop:not([hidden]) .cb-opt', { settle: 500 });
    const picked = await evaluate(s, `({ title: document.getElementById('inTitle').value, place: document.getElementById('inLocation').value })`);
    await t('tp-ui H: picking stores the bare hotel name and keeps the typed city',
      picked.title === 'Novotel Bangkok Sukhumvit' && picked.place === 'Bangkok', JSON.stringify(picked), s);
    const geo = await evaluate(s, `(JSON.parse(localStorage.getItem('trip-planner:geo:v3')||'{}')['novotel bangkok sukhumvit']||null)`);
    await t('tp-ui H: the pick seeds the geocode cache with the hotel own coordinates',
      !!geo && Math.abs(geo.lat - 13.7390) < 0.001 && Math.abs(geo.lon - 100.5600) < 0.001 && geo.conf === 'confident',
      JSON.stringify(geo), s);

    // the combobox belongs to the STAY type only, checked per search because
    // the type switches under an open form
    const callsBefore = photonCalls;
    await clickSel(s, '#typePicker [data-type="activity"]', { settle: 300 });
    await typeInto(s, '#inTitle', 'novotel');
    // NEGATIVE claim (no dropdown, no request): nothing observable to wait
    // for, so a fixed beat past the 320ms debounce is the only honest wait
    await sleep(900);
    const popOpen = await evaluate(s, `!!(${visiblePop})`);
    await t('tp-ui H: the combobox exists for a stay and only a stay',
      !popOpen && photonCalls === callsBefore, `popOpen=${popOpen} calls=${photonCalls}/${callsBefore}`, s);
    await escape(s);
  });

  // Photon down or slow degrades SILENTLY (FINDINGS: empty dropdown, no
  // crash, the field stays a plain text input). The default net rule refuses
  // photon.komoot.io, which is this exact outage.
  freshIds();
  const seedH2 = trip({ name: 'Hotel picker offline', items: [item({ title: 'Existing plan', startDate: iso(30), startTime: '10:00' })] });
  await withPage('tp-ui H2', { db: dbOf([seedH2]) }, async (s) => {
    await openAddItem(s);
    await clickSel(s, '#typePicker [data-type="stay"]', { settle: 300 });
    await typeInto(s, '#inTitle', 'novotel');
    // NEGATIVE claim again: the refused fetch must produce no dropdown and no
    // dialog change, so wait a beat past debounce + failure and look
    await sleep(1200);
    const state = await evaluate(s, `({
      pop: !!([...document.querySelectorAll('.cb-pop')].find(x=>!x.hidden)),
      dialogOpen: document.getElementById('itemOverlay').classList.contains('open'),
      value: document.getElementById('inTitle').value,
    })`);
    await t('tp-ui H2: a failed Photon lookup degrades to a silent plain field',
      !state.pop && state.dialogOpen && state.value === 'novotel', JSON.stringify(state), s);
    await escape(s);
  });

  return R;
}
