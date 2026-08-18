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
  switchView, escape, closePage, evaluate, expandTimeline,
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

    // The title combobox belongs to the STAY and ACTIVITY types, checked per
    // search because the type switches under an open form. A note has neither
    // list, and is the negative control that pins the gate still exists.
    const callsBefore = photonCalls;
    await clickSel(s, '#typePicker [data-type="note"]', { settle: 300 });
    await typeInto(s, '#inTitle', 'novotel');
    // NEGATIVE claim (no dropdown, no request): nothing observable to wait
    // for, so a fixed beat past the 320ms debounce is the only honest wait
    await sleep(900);
    const popOpen = await evaluate(s, `!!(${visiblePop})`);
    await t('tp-ui H: a type with no list opens no dropdown and asks nothing',
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

  /* --------- V. venue picker (the activity-only title combobox) ---------- */
  // The same wire-to-DOM path block H pins for hotels, for the class list that
  // makes an ACTIVITY title complete a real place. Photon is canned, so this
  // pins ranking, the class allowlist, what a pick fills in, and the coordinate
  // seed - the last of which is the actual prize: a hand-added activity used to
  // sit on its city's centroid until some later lookup found it.
  const VENUE_OK = {
    features: [
      // Photon's own order puts the Osaka one first: the Place-field city must beat it
      { properties: { name: 'teamLab Botanical Garden', osm_key: 'leisure', osm_value: 'garden', city: 'Osaka', country: 'Japan', countrycode: 'JP' }, geometry: { coordinates: [135.5262, 34.6520] } },
      { properties: { name: 'teamLab Planets', osm_key: 'tourism', osm_value: 'museum', city: 'Tokyo', country: 'Japan', countrycode: 'JP' }, geometry: { coordinates: [139.7897, 35.6494] } },
      { properties: { name: 'teamLab Cafe', osm_key: 'amenity', osm_value: 'cafe', city: 'Tokyo', country: 'Japan', countrycode: 'JP' }, geometry: { coordinates: [139.7800, 35.6400] } },
      // the exclusions are a request, not a guarantee, and the class list is
      // the actual gate: neither of these may reach the field
      { properties: { name: 'teamLab', osm_key: 'highway', osm_value: 'bus_stop', city: 'Tokyo', country: 'Japan', countrycode: 'JP' }, geometry: { coordinates: [139.77, 35.63] } },
      { properties: { name: 'teamLab Hotel', osm_key: 'tourism', osm_value: 'hotel', city: 'Tokyo', country: 'Japan', countrycode: 'JP' }, geometry: { coordinates: [139.76, 35.62] } },
    ],
  };
  freshIds();
  const seedV = trip({ name: 'Venue picker trip', items: [item({ title: 'Existing plan', startDate: iso(30), startTime: '10:00' })] });
  // The two pickers are one input against one provider, told apart on the wire
  // by their tag parameters: the hotel query INCLUDES tourism:*, the venue
  // query EXCLUDES !highway. A rule that could not tell them apart would let
  // the hotel payload answer a venue search and prove nothing.
  let venueCalls = 0, hotelCalls = 0, placesCalls = 0;
  // encodeURIComponent leaves "!" alone, so the venue query carries a LITERAL
  // `osm_tag=!highway` (both spellings are accepted here rather than assuming
  // one, since which of them appears is an encoding detail, not a contract).
  // Neither branch is a catch-all: a request matching neither shape fails the
  // fetch, so a third request shape cannot quietly answer with someone else's
  // payload the way it did on the first run of this block.
  const twoPickerNet = (url) => {
    // The billed endpoint is counted too: this feature must add exactly zero
    // rating requests, and a count is the only way to say so rather than hope.
    if (/tp-places/i.test(url)) { placesCalls += 1; return { status: 200, body: { results: [] } }; }
    if (/photon\.komoot\.io/i.test(url)) {
      if (/osm_tag=(!|%21)/i.test(url)) { venueCalls += 1; return { status: 200, body: VENUE_OK }; }
      if (/osm_tag=tourism(%3A|:)/i.test(url)) { hotelCalls += 1; return { status: 200, body: PHOTON_OK }; }
      return 'fail';
    }
    return EXTERNAL_HOSTS.test(url) ? 'fail' : null;
  };
  await withPage('tp-ui V', { db: dbOf([seedV]), net: twoPickerNet }, async (s) => {
    const visiblePop = `[...document.querySelectorAll('.cb-pop')].find(x=>!x.hidden)`;
    const placesAtStart = placesCalls;
    await openAddItem(s);
    await clickSel(s, '#typePicker [data-type="activity"]', { settle: 300 });
    await setValue(s, '#inLocation', 'Tokyo');
    // A modal opening is not a reason to spend a request, on either endpoint.
    await sleep(600);
    await t('tp-ui V: opening the form asks nothing of anybody',
      venueCalls === 0 && hotelCalls === 0, `venue=${venueCalls} hotel=${hotelCalls}`, s);
    await typeInto(s, '#inTitle', 'teamlab');
    const open = await waitForExpr(s, `(()=>{const p=${visiblePop}; return !!p && p.children.length>0})()`, { timeout: 6000 });
    const rows = await evaluate(s, `(()=>{const p=${visiblePop}; return p ? [...p.children].map(o=>({
      main:(o.querySelector('.cb-main')||{}).textContent||'', tag:(o.querySelector('.cb-tag')||{}).textContent||''})) : []})()`);
    await t('tp-ui V: typing an activity title shows ranked venue suggestions',
      open && rows.length === 3, JSON.stringify(rows), s);
    await t('tp-ui V: the Place-field city outranks Photon order',
      rows.length > 0 && rows[0].main === 'teamLab Planets' && rows[0].tag === 'Museum', JSON.stringify(rows[0] || null), s);
    await t('tp-ui V: an excluded class and a hotel never reach the activity field',
      rows.every(r => r.tag !== 'Hotel') && rows.every(r => !/bus/i.test(r.tag)) && rows.length === 3,
      JSON.stringify(rows.map(r => r.tag)), s);
    await t('tp-ui V: an activity search asks the venue query, never the hotel one',
      venueCalls > 0 && hotelCalls === 0, `venue=${venueCalls} hotel=${hotelCalls}`, s);

    await clickSel(s, '.cb-pop:not([hidden]) .cb-opt', { settle: 500 });
    const picked = await evaluate(s, `({ title: document.getElementById('inTitle').value, place: document.getElementById('inLocation').value })`);
    await t('tp-ui V: picking stores the bare venue name and keeps the typed city',
      picked.title === 'teamLab Planets' && picked.place === 'Tokyo', JSON.stringify(picked), s);
    // MEASURED FROM OPEN TO PICK, deliberately not across the save. Typing and
    // choosing are the picker, and they must cost nothing: a hotel pick fires
    // one rating call and a venue pick fires none. What happens AFTER the save
    // is a different subsystem - the saved row becomes an ordinary
    // rating-eligible itinerary row and is looked up by the existing
    // IntersectionObserver queue under the existing quota, which is the
    // already-approved point in the workflow and is not this feature's doing.
    await t('tp-ui V: typing a venue name and picking one costs nothing billable',
      placesCalls === placesAtStart, `places=${placesCalls}/${placesAtStart}`, s);
    await t('tp-ui V: typing a venue name stays within a couple of requests',
      venueCalls > 0 && venueCalls <= 3, `venueCalls=${venueCalls}`, s);

    // The coordinate lands only on SAVE, under the key the saved item asks for
    // (itemMapsQuery), which is what makes the two agree by construction.
    await clickSel(s, '#itemSaveBtn', { settle: 800 });
    const seeded = await evaluate(s, `(()=>{
      const db = JSON.parse(localStorage.getItem('trip-planner:v1')||'null');
      const trip = db.trips[0];
      const it = trip.items.find(x => x.title === 'teamLab Planets');
      if (!it) return { missing: true };
      const key = TripLogic.placeCacheKey(TripLogic.itemMapsQuery(it));
      const rec = (JSON.parse(localStorage.getItem('trip-planner:venuegeo:v1')||'{}'))[key] || null;
      return { key, rec, place: it.location, date: it.startDate };
    })()`);
    await t('tp-ui V: a picked venue seeds its own coordinates for the saved item',
      !!seeded.rec && Math.abs(seeded.rec.lat - 35.6494) < 0.001 && Math.abs(seeded.rec.lon - 139.7897) < 0.001,
      JSON.stringify(seeded), s);

    // A retyped title is a different place, so the coordinates must NOT follow it
    await openAddItem(s);
    await clickSel(s, '#typePicker [data-type="activity"]', { settle: 250 });
    await setValue(s, '#inLocation', 'Tokyo');
    await typeInto(s, '#inTitle', 'teamlab');
    await waitForExpr(s, `(()=>{const p=${visiblePop}; return !!p && p.children.length>0})()`, { timeout: 6000 });
    await clickSel(s, '.cb-pop:not([hidden]) .cb-opt', { settle: 400 });
    await setValue(s, '#inTitle', 'Somewhere else entirely');
    // setValue fires `input`, which arms the 320ms combobox search; moving focus
    // off the field is how the picker itself cancels that, and it keeps a
    // dropdown from opening over the Save button mid-click.
    await setValue(s, '#inLocation', 'Tokyo');
    await clickSel(s, '#itemSaveBtn', { settle: 800 });
    const notStamped = await evaluate(s, `(()=>{
      const db = JSON.parse(localStorage.getItem('trip-planner:v1')||'null');
      const it = db.trips[0].items.find(x => x.title === 'Somewhere else entirely');
      if (!it) return { missing: true };
      const key = TripLogic.placeCacheKey(TripLogic.itemMapsQuery(it));
      return { key, rec: (JSON.parse(localStorage.getItem('trip-planner:venuegeo:v1')||'{}'))[key] || null };
    })()`);
    await t('tp-ui V: retyping the title drops the picked coordinates rather than moving them',
      !notStamped.missing && notStamped.rec === null, JSON.stringify(notStamped), s);
  });

  // Photon down degrades silently here too: the field stays a plain text input
  // and the item still saves. The default net rule refuses photon.komoot.io.
  freshIds();
  const seedV2 = trip({ name: 'Venue picker offline', items: [item({ title: 'Existing plan', startDate: iso(30), startTime: '10:00' })] });
  await withPage('tp-ui V2', { db: dbOf([seedV2]) }, async (s) => {
    await openAddItem(s);
    await clickSel(s, '#typePicker [data-type="activity"]', { settle: 300 });
    await typeInto(s, '#inTitle', 'teamlab');
    // NEGATIVE claim: the refused fetch must produce no dropdown at all
    await sleep(1200);
    const state = await evaluate(s, `({
      pop: !!([...document.querySelectorAll('.cb-pop')].find(x=>!x.hidden)),
      dialogOpen: document.getElementById('itemOverlay').classList.contains('open'),
      value: document.getElementById('inTitle').value,
    })`);
    await t('tp-ui V2: a failed venue lookup degrades to a silent plain field',
      !state.pop && state.dialogOpen && state.value === 'teamlab', JSON.stringify(state), s);
    await clickSel(s, '#itemSaveBtn', { settle: 700 });
    const saved = await evaluate(s, `(()=>{const db=JSON.parse(localStorage.getItem('trip-planner:v1')||'null');
      return db.trips[0].items.some(x => x.title === 'teamlab')})()`);
    await t('tp-ui V2: the item still saves with the typed text', saved, '', s);
  });

  // Keyboard driving of the title combobox. It had no coverage at all before
  // this round, for either picker: every existing check drove it with a pointer,
  // so the ARIA wiring and the Enter-swallowing were untested. Enter is the
  // interesting one - the combobox may only swallow it while a row is
  // highlighted, or a traveller typing a place the app does not list could no
  // longer submit the form with the keyboard.
  freshIds();
  const seedV3 = trip({ name: 'Venue keyboard trip', items: [item({ title: 'Existing plan', startDate: iso(30), startTime: '10:00' })] });
  await withPage('tp-ui V3', { db: dbOf([seedV3]), net: twoPickerNet }, async (s) => {
    const visiblePop = `[...document.querySelectorAll('.cb-pop')].find(x=>!x.hidden)`;
    await openAddItem(s);
    await clickSel(s, '#typePicker [data-type="activity"]', { settle: 300 });
    await setValue(s, '#inLocation', 'Tokyo');
    await typeInto(s, '#inTitle', 'teamlab');
    await waitForExpr(s, `(()=>{const p=${visiblePop}; return !!p && p.children.length>0})()`, { timeout: 6000 });
    const aria = await evaluate(s, `(()=>{const i=document.getElementById('inTitle'); const p=${visiblePop};
      return { role:i.getAttribute('role'), expanded:i.getAttribute('aria-expanded'), controls:i.getAttribute('aria-controls'),
               popId:p&&p.id, popRole:p&&p.getAttribute('role'), optRole:p&&p.firstElementChild.getAttribute('role') }})()`);
    await t('tp-ui V3: the field is wired as a combobox over a listbox',
      aria.role === 'combobox' && aria.expanded === 'true' && aria.controls === aria.popId
      && aria.popRole === 'listbox' && aria.optRole === 'option', JSON.stringify(aria), s);

    await pressKey(s, 'ArrowDown', 'ArrowDown', 40);
    const active = await evaluate(s, `(()=>{const i=document.getElementById('inTitle'); const p=${visiblePop};
      const id=i.getAttribute('aria-activedescendant'); const el=id&&document.getElementById(id);
      return { id, first:p&&p.firstElementChild.id, selected:el&&el.getAttribute('aria-selected'), on:!!(el&&el.classList.contains('on')) }})()`);
    await t('tp-ui V3: ArrowDown highlights the first row and says so to a reader',
      !!active.id && active.id === active.first && active.selected === 'true' && active.on, JSON.stringify(active), s);

    await pressKey(s, 'Enter', 'Enter', 13);
    const afterEnter = await evaluate(s, `({
      title: document.getElementById('inTitle').value,
      pop: !!(${visiblePop}),
      dialogOpen: document.getElementById('itemOverlay').classList.contains('open'),
      items: (JSON.parse(localStorage.getItem('trip-planner:v1')||'{}').trips||[{}])[0].items.length,
    })`);
    await t('tp-ui V3: Enter picks the highlighted row instead of submitting the form',
      afterEnter.title === 'teamLab Planets' && !afterEnter.pop && afterEnter.dialogOpen && afterEnter.items === 1,
      JSON.stringify(afterEnter), s);

    // Escape with a dropdown open closes the DROPDOWN only: losing the whole
    // form to a dismissal of the list would be the worst version of this.
    await typeInto(s, '#inTitle', 'teamlab');
    await waitForExpr(s, `(()=>{const p=${visiblePop}; return !!p && p.children.length>0})()`, { timeout: 6000 });
    await escape(s);
    const afterEsc = await evaluate(s, `({ pop: !!(${visiblePop}), dialogOpen: document.getElementById('itemOverlay').classList.contains('open') })`);
    await t('tp-ui V3: Escape closes the list and keeps the form',
      !afterEsc.pop && afterEsc.dialogOpen, JSON.stringify(afterEsc), s);
    await escape(s);
  });

  /* ------------- S. contextual defaults on a blank Add form -------------- */
  // The inference itself is pinned by tests/smart-defaults.test.js. What can
  // only be checked in a browser is the CONTRACT around it: a derived value
  // lands in an empty field, an edit never gets one, and nothing the traveller
  // typed is ever overwritten.
  freshIds();
  const seedS = standardTrip();          // flight in 30d, Tokyo stay, Kyoto stay
  await withPage('tp-ui S', { db: dbOf([seedS]) }, async (s) => {
    const formState = () => evaluate(s, `({
      type: (document.querySelector('#typePicker button[aria-pressed="true"]')||{dataset:{}}).dataset.type || '',
      start: document.getElementById('inStart').value,
      place: document.getElementById('inLocation').value,
      end: document.getElementById('inEnd').value,
      title: document.getElementById('inTitle').value,
    })`);

    // 1. the toolbar Add on a trip that already holds items
    await openAddItem(s);
    const a = await formState();
    await t('tp-ui S: a blank form opens on Activity once the trip holds anything',
      a.type === 'activity', JSON.stringify(a), s);
    await t('tp-ui S: and on the trip first day while the trip is still ahead',
      a.start === iso(30), JSON.stringify(a), s);
    await escape(s);

    // 2. a day card's + names its own day AND its own city
    await switchView(s, 'days');
    const dayAdd = await clickSel(s, `.day-card [data-act="add-day"][data-date="${iso(32)}"]`, { settle: 500 });
    const b = await formState();
    await t('tp-ui S: a day card + opens on that day and that day city',
      dayAdd && b.start === iso(32) && b.place === 'Tokyo', JSON.stringify(b), s);

    // 3. switching type never touches what the traveller typed
    await setValue(s, '#inLocation', 'Nakameguro');
    await setValue(s, '#inStart', iso(33));
    await clickSel(s, '#typePicker [data-type="local"]', { settle: 300 });
    const c = await formState();
    await t('tp-ui S: a typed place and date survive a type change',
      c.place === 'Nakameguro' && c.start === iso(33), JSON.stringify(c), s);

    // 4. choosing Stay fills the dates it can compute, and only the empty ones
    await clickSel(s, '#typePicker [data-type="stay"]', { settle: 350 });
    const d = await formState();
    await t('tp-ui S: choosing Stay fills check-out without touching the typed check-in',
      d.start === iso(33) && d.end === iso(34), JSON.stringify(d), s);
    await escape(s);

    // 5. an EDIT is the item's own values, never a derived default
    await switchView(s, 'timeline');
    // the note nests inside the stay covering it and Timeline groups start
    // collapsed, so its edit button is unreachable until they are opened
    await expandTimeline(s);
    const opened = await clickSel(s, `.tp-row[data-id="${seedS.items[4].id}"] button[data-act="edit"]`, { settle: 450 });
    const e = await formState();
    await t('tp-ui S: editing an item derives nothing, it shows what the item says',
      opened && (await overlayOpenId(s)) === 'itemOverlay'
      && e.type === 'note' && e.place === '' && e.start === iso(33) && e.title === 'Buy JR Pass',
      JSON.stringify(e), s);
    await escape(s);
  });

  // The prefilled fix on the "no transport between two cities" warning. The
  // warning only renders when BOTH cities are already geocoded (it never
  // touches the network), so the geocode cache is seeded through `stores`,
  // which lands before the app's first load.
  freshIds();
  const seedS2 = trip({
    name: 'Gap trip',
    items: [
      item({ type: 'stay', title: 'Hotel Paris', location: 'Paris', startDate: iso(20), endDate: iso(23), status: 'booked' }),
      item({ type: 'stay', title: 'Hotel Brussels', location: 'Brussels', startDate: iso(23), endDate: iso(25), status: 'booked' }),
    ],
  });
  const geoStore = {
    paris: { lat: 48.8566, lon: 2.3522, name: 'Paris', cc: 'FR', country: 'France', conf: 'confident' },
    brussels: { lat: 50.8476, lon: 4.3572, name: 'Brussels', cc: 'BE', country: 'Belgium', conf: 'confident' },
  };
  await withPage('tp-ui S2', { db: dbOf([seedS2]), stores: { 'trip-planner:geo:v3': geoStore } }, async (s) => {
    const hasWarn = await waitForExpr(s, `[...document.querySelectorAll('#issuesList li')].some(li=>/No flight or transport is logged/i.test(li.textContent))`, { timeout: 6000 });
    await t('tp-ui S2: the city-change warning is raised', hasWarn, '', s);
    // The panel is a <details> that starts closed: textContent reads straight
    // through it, so the check above passes either way, but a click on a
    // zero-rect button inside it lands nowhere.
    await evaluate(s, `document.getElementById('issuesDetails').open = true`);
    const clicked = await clickSel(s, '#issuesList button[data-add-transport]', { settle: 600 });
    const f = await evaluate(s, `({
      open: document.getElementById('itemOverlay').classList.contains('open'),
      type: (document.querySelector('#typePicker button[aria-pressed="true"]')||{dataset:{}}).dataset.type || '',
      title: document.getElementById('inTitle').value,
      start: document.getElementById('inStart').value,
      place: document.getElementById('inLocation').value,
    })`);
    await t('tp-ui S2: Add transport opens the leg already written and dated',
      clicked && f.open && f.type === 'transport' && f.title === 'Paris to Brussels' && f.start === iso(23),
      JSON.stringify(f), s);
    // a between-cities leg keeps its route in the TITLE and takes no city, or
    // dayMorningCity would read a departure day as its destination
    await t('tp-ui S2: the prefilled leg takes no city', f.place === '', JSON.stringify(f), s);

    // saving it answers the warning that offered it
    await clickSel(s, '#itemSaveBtn', { settle: 800 });
    const gone = await waitForExpr(s, `![...document.querySelectorAll('#issuesList li')].some(li=>/No flight or transport is logged/i.test(li.textContent))`, { timeout: 5000 });
    await t('tp-ui S2: saving the prefilled leg clears the warning', gone, '', s);

    // The toolbar's Route dialog opens on the trip's own city pair, and opening
    // it must NOT spend a lookup: the blank result panel is the proof that
    // checkRoute did not run (every external host is refused here anyway, so a
    // check would have painted an error instead).
    await clickSel(s, '#routeBtn', { settle: 600 });
    const r = await evaluate(s, `({
      open: document.getElementById('routeOverlay').classList.contains('open'),
      from: document.getElementById('routeFrom').value,
      to: document.getElementById('routeTo').value,
      blank: /Compare the ways to get there/i.test(document.getElementById('routeResult').innerText),
      armed: !document.getElementById('routeCheckBtn').disabled,
      focused: document.activeElement && document.activeElement.id,
    })`);
    await t('tp-ui S2: Route opens on the trip own city pair without spending a lookup',
      r.open && r.from === 'Paris' && r.to === 'Brussels' && r.blank && r.armed, JSON.stringify(r), s);
    await t('tp-ui S2: focus lands on the button that runs it', r.focused === 'routeCheckBtn', JSON.stringify(r), s);
    await escape(s);
  });

  // The other prefilled fix: an uncovered night now carries the CITY it is spent
  // in as well as its dates, which is the whole reason it needs the trip.
  freshIds();
  const seedS3 = trip({
    name: 'Uncovered night trip',
    items: [
      item({ type: 'stay', title: 'Hotel Paris', location: 'Paris', startDate: iso(20), endDate: iso(23), status: 'booked' }),
      item({ type: 'activity', title: 'Flea market', location: 'Paris', startDate: iso(24), startTime: '10:00' }),
    ],
  });
  await withPage('tp-ui S3', { db: dbOf([seedS3]) }, async (s) => {
    const hasGap = await waitForExpr(s, `[...document.querySelectorAll('#issuesList li')].some(li=>/No stay covers/i.test(li.textContent))`, { timeout: 6000 });
    await t('tp-ui S3: the uncovered-night warning is raised', hasGap, '', s);
    await evaluate(s, `document.getElementById('issuesDetails').open = true`);
    const clicked = await clickSel(s, '#issuesList button[data-add-stay]', { settle: 600 });
    const g = await evaluate(s, `({
      open: document.getElementById('itemOverlay').classList.contains('open'),
      type: (document.querySelector('#typePicker button[aria-pressed="true"]')||{dataset:{}}).dataset.type || '',
      start: document.getElementById('inStart').value,
      end: document.getElementById('inEnd').value,
      place: document.getElementById('inLocation').value,
    })`);
    await t('tp-ui S3: Add stay opens on the uncovered range AND its city',
      clicked && g.open && g.type === 'stay' && g.start === iso(23) && g.end === iso(24) && g.place === 'Paris',
      JSON.stringify(g), s);
  });

  /* ---- S4. the overwrite invariant, and the check-in anchor regression ---- */
  // The rule this whole round rests on: a derived value may only ever land in a
  // field that would otherwise have opened EMPTY. This block types into every
  // field a default could touch and then fires every inference that runs after
  // an open - type switches, a venue pick, a hotel pick - and asserts nothing
  // the traveller wrote moved.
  freshIds();
  const seedS4 = trip({
    name: 'Overwrite trip',
    items: [
      // covered the 5th-8th and the 10th-12th relative to today, with today
      // INSIDE the trip so the form opens on today: the exact shape that made
      // "choose Stay" write a four-night stay straddling both bookings.
      item({ type: 'stay', title: 'Hotel One', location: 'Paris', startDate: iso(-2), endDate: iso(1), status: 'booked' }),
      item({ type: 'stay', title: 'Hotel Two', location: 'Lyon', startDate: iso(3), endDate: iso(5), status: 'booked' }),
    ],
  });
  await withPage('tp-ui S4', { db: dbOf([seedS4]), net: twoPickerNet }, async (s) => {
    const visiblePop = `[...document.querySelectorAll('.cb-pop')].find(x=>!x.hidden)`;
    const form = () => evaluate(s, `({
      type: (document.querySelector('#typePicker button[aria-pressed="true"]')||{dataset:{}}).dataset.type || '',
      title: document.getElementById('inTitle').value,
      place: document.getElementById('inLocation').value,
      start: document.getElementById('inStart').value,
      end: document.getElementById('inEnd').value,
      from: document.getElementById('inFlightFrom').value,
    })`);

    // 1. the date the APP wrote is the app's to improve on: choosing Stay jumps
    // to the first night with no bed (here iso(1)-iso(3)), which is the whole
    // point of the feature.
    await openAddItem(s);
    const opened = await form();
    await t('tp-ui S4: a running trip opens on today', opened.start === iso(0), JSON.stringify(opened), s);
    await clickSel(s, '#typePicker [data-type="stay"]', { settle: 400 });
    const jumped = await form();
    await t('tp-ui S4: Stay moves an app-written date to the first uncovered night',
      jumped.start === iso(1) && jumped.end === iso(3), JSON.stringify(jumped), s);
    await escape(s);

    // 2. the REGRESSION: a check-in the traveller typed is an anchor, not a
    // doorway to the next hole. Before field ownership this wrote check-out
    // iso(3) against a typed check-in of today - a stay straddling BOTH
    // existing bookings.
    await openAddItem(s);
    await setValue(s, '#inStart', iso(0));
    await clickSel(s, '#typePicker [data-type="stay"]', { settle: 400 });
    const anchored = await form();
    await t('tp-ui S4: a typed check-in anchors the stay and adds one night',
      anchored.start === iso(0) && anchored.end === iso(1), JSON.stringify(anchored), s);
    await escape(s);

    // 3. everything typed survives every later inference
    await openAddItem(s);
    await clickSel(s, '#typePicker [data-type="flight"]', { settle: 300 });
    await setValue(s, '#inFlightFrom', 'MY OWN AIRPORT');
    await setValue(s, '#inTitle', 'My own title');
    await setValue(s, '#inLocation', 'Nakameguro');
    await setValue(s, '#inStart', iso(2));
    const typed = await form();
    for (const type of ['stay', 'activity', 'local', 'note', 'transport', 'flight']) {
      await clickSel(s, `#typePicker [data-type="${type}"]`, { settle: 220 });
    }
    const after = await form();
    await t('tp-ui S4: six type switches move nothing the traveller typed',
      after.title === typed.title && after.place === typed.place
      && after.start === typed.start && after.from === typed.from,
      `typed=${JSON.stringify(typed)} after=${JSON.stringify(after)}`, s);

    // 4. the complement of (3): a value the APP wrote may be improved on. The
    // red-eye case is the one that matters - the form opens on the trip's first
    // day, which on an overnight flight is the night spent in the air.
    await escape(s);
    await openAddItem(s);
    await clickSel(s, '#typePicker [data-type="stay"]', { settle: 400 });
    const derived = await form();
    await t('tp-ui S4: and it does so every time, not just on the first open',
      derived.start === iso(1) && derived.end === iso(3), JSON.stringify(derived), s);

    // 5. the city follows the day, but only while the app owns it
    await clickSel(s, '#typePicker [data-type="activity"]', { settle: 300 });
    await setValue(s, '#inStart', iso(4));
    await sleep(250);
    const moved = await form();
    await t('tp-ui S4: moving the date re-derives an app-written city',
      moved.place === 'Lyon', JSON.stringify(moved), s);
    await setValue(s, '#inLocation', 'Villeurbanne');
    await setValue(s, '#inStart', iso(-1));
    await sleep(250);
    const mine = await form();
    await t('tp-ui S4: a city the traveller typed is never re-derived',
      mine.place === 'Villeurbanne', JSON.stringify(mine), s);
    await escape(s);
    await openAddItem(s);

    // 6. a pick fills an EMPTY place and leaves a filled one alone
    await clickSel(s, '#typePicker [data-type="activity"]', { settle: 300 });
    await setValue(s, '#inLocation', 'Nakameguro');
    await typeInto(s, '#inTitle', 'teamlab');
    await waitForExpr(s, `(()=>{const p=${visiblePop}; return !!p && p.children.length>0})()`, { timeout: 6000 });
    await clickSel(s, '.cb-pop:not([hidden]) .cb-opt', { settle: 400 });
    const keptPlace = await form();
    await t('tp-ui S4: picking a venue never overwrites a typed place',
      keptPlace.place === 'Nakameguro', JSON.stringify(keptPlace), s);
    // and a city a PICK filled is the traveller's too: moving the day after it
    // must not wipe the town that came with the venue they chose
    await setValue(s, '#inLocation', '');
    await evaluate(s, `document.getElementById('inLocation').value=''`);
    await typeInto(s, '#inTitle', 'teamlab');
    await waitForExpr(s, `(()=>{const p=${visiblePop}; return !!p && p.children.length>0})()`, { timeout: 6000 });
    await clickSel(s, '.cb-pop:not([hidden]) .cb-opt', { settle: 400 });
    const fromPick = await form();
    await setValue(s, '#inStart', iso(4));
    await sleep(250);
    const afterMove = await form();
    await t('tp-ui S4: a city a pick supplied survives a later date change',
      fromPick.place === 'Tokyo' && afterMove.place === 'Tokyo',
      `pick=${JSON.stringify(fromPick)} moved=${JSON.stringify(afterMove)}`, s);
    await escape(s);
  });

  return R;
}
