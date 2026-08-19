// Trip Planner E2E: the 2026-08-19 exploratory QA round.
//
// The findings from that round whose fix is a DOM or state fact, so they belong
// in a browser rather than in tests/qa-2026-08-19.test.js (which owns the pure
// logic: day inference, sample currency, transport modes, units, airport
// search). One block per finding, named by its id:
//
//   TP-01  bulk currency CONVERTS and confirms, never relabels
//   TP-03  hotel/venue lookup is biased to the city the form already knows
//   TP-06  the map drops the previous trip's canvas the moment the trip changes
//   TP-07  costs no rate can convert are named, not just counted
//   TP-08  a refused rating match says so instead of showing nothing
//   TP-09  the Issues chip is reachable on a phone
//   TP-10  a warned row states its warning in text, not only in colour
//   TP-11  a single-stop map opens on the city, not a street
//   TP-12  the assistant opens on the free one-click tier
//   TP-13  the Items chip and Select all no longer contradict each other
//   TP-14  a climate figure is labelled "Typical" on the chip itself
//   TP-15  the Book-by row stands down once the item is Booked
//   TP-16  the preference rows expose their state
//   TP-17  sharing explains what is in the link BEFORE copying it
//   TP-18  a flight form opens on the airport pair
//   TP-21  the GPX export resolves its own coordinates
//   TP-22  an empty trip does not fill a phone screen with dead controls
//   TP-23  delete confirms describe what undo actually guarantees
import {
  APP, recorder, freshIds, iso, item, trip, dbOf, standardTrip,
  openApp, readDb, tpErrors, closePage, evaluate, waitForExpr,
  clickSel, setValue, switchView, menuAct, openMenu, openAddItem, escape,
  toastText, overlayOpenId, sleep, setViewport, screenshot,
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

  /* ============ TP-01: bulk currency converts, and asks first ============= */
  freshIds();
  const moneyTrip = trip({
    name: 'Money', currency: 'USD',
    items: [
      item({ type: 'flight', title: 'Flight', startDate: iso(30), status: 'booked', cost: 480, costCurrency: 'USD' }),
      item({ type: 'stay', title: 'Hotel', location: 'Lima', startDate: iso(30), endDate: iso(33), status: 'booked', cost: 690, costCurrency: 'USD' }),
      item({ title: 'Museum', location: 'Lima', startDate: iso(31), status: 'booked', cost: 45, costCurrency: 'PEN' }),
    ],
  });
  // A canned rate payload: the suite blocks every external host by default, and
  // this operation must not be tested against whatever the ECB says today.
  const ratesNet = (url) => {
    if (/frankfurter/.test(url)) {
      return { body: JSON.stringify({ base: 'USD', date: '2026-08-19', rates: { EUR: 0.5, GBP: 0.8, JPY: 100 } }), contentType: 'application/json' };
    }
    return /^https?:\/\/(localhost|127\.)/.test(url) ? null : 'fail';
  };
  await withPage('tp-qa TP-01', { db: dbOf([moneyTrip]), net: ratesNet }, async (s) => {
    const costs = () => evaluate(s, `(()=>{const d=JSON.parse(localStorage.getItem('trip-planner:v1'));
      const tr=d.trips.find(x=>x.id===d.activeTripId);
      return tr.items.map(i=>i.title+':'+i.cost+':'+(i.costCurrency||''))})()`);
    const before = await costs();

    await clickSel(s, '#selectBtn');
    await waitForExpr(s, `!!document.querySelector('#bulkAll')`, { timeout: 5000 });
    await evaluate(s, `(()=>{const c=document.querySelector('#bulkAll'); if(!c.checked) c.click(); return 1})()`);
    await waitForExpr(s, `/[1-9]\\d* selected/.test(document.querySelector('#bulkCount').textContent)`, { timeout: 5000 });

    // choosing a currency must NOT write anything yet
    await evaluate(s, `(()=>{const sel=document.querySelector('#bulkCurrency'); sel.value='EUR';
      sel.dispatchEvent(new Event('change',{bubbles:true})); return 1})()`);
    await waitForExpr(s, `document.querySelector('#confirmOverlay.overlay.open') !== null`, { timeout: 5000 });
    await t('TP-01: a bulk currency change asks before it writes',
      JSON.stringify(await costs()) === JSON.stringify(before), (await costs()).join(' | '), s);

    const dlg = await evaluate(s, `document.querySelector('#confirmTitle').textContent + ' :: ' + document.querySelector('#confirmText').textContent`);
    await t('TP-01: the confirm says CONVERT, with the count and the target',
      /Convert 2 costs to EUR\?/.test(dlg), dlg.slice(0, 160), s);
    await t('TP-01: the confirm names what cannot be converted',
      /cannot be converted/.test(dlg) && /Museum/.test(dlg) && /PEN/.test(dlg), dlg.slice(0, 260), s);

    await clickSel(s, '#confirmYes');
    await waitForExpr(s, `document.querySelector('#confirmOverlay.overlay.open') === null`, { timeout: 5000 });
    const after = await costs();
    // 480 USD -> 240 EUR and 690 -> 345 at the canned 0.5; PEN is untouched.
    await t('TP-01: amounts are converted, not relabelled',
      after.includes('Flight:240:EUR') && after.includes('Hotel:345:EUR'), after.join(' | '), s);
    await t('TP-01: an unconvertible cost keeps its own currency and amount',
      after.includes('Museum:45:PEN'), after.join(' | '), s);

    // undo still reverses the whole thing in one step
    await evaluate(s, `document.querySelector('#undoBtn').click()`);
    await sleep(400);
    await t('TP-01: undo reverses the conversion',
      JSON.stringify(await costs()) === JSON.stringify(before), (await costs()).join(' | '), s);
  });

  /* ============ TP-07: unconvertible costs are NAMED ====================== */
  await withPage('tp-qa TP-07', { db: dbOf([moneyTrip]), net: ratesNet }, async (s) => {
    // textContent, NOT innerText: the list sits inside a collapsed <details>,
    // and innerText returns '' for hidden content (the trap the original QA
    // probe fell into and mis-reported as "there is no warning text").
    const issues = () => evaluate(s, `document.querySelector('#issuesList').textContent`);
    await waitForExpr(s, `/No exchange rate/.test(document.querySelector('#issuesList').textContent)`, { timeout: 10000 });
    const text = await issues();
    await t('TP-07: the shortfall names the item and the currency',
      /PEN/.test(text) && /Museum/.test(text), text.replace(/\s+/g, ' ').slice(0, 200), s);
    await t('TP-07: and says what it means for the totals',
      /left out of every total/.test(text), text.replace(/\s+/g, ' ').slice(0, 200), s);
    // the currency picker must not offer a code the provider cannot price
    const opts = await evaluate(s, `(()=>{const sel=document.querySelector('#inCostCurrency');
      return [...sel.options].map(o=>o.value).join(',')})()`);
    await t('TP-07: the picker no longer offers BGN, which has no rate',
      !opts.split(',').includes('BGN'), opts.slice(0, 120), s);
  });

  /* ============ TP-10 / TP-13 / TP-23: warnings, counts, wording ========== */
  freshIds();
  const warnTrip = trip({
    name: 'Warnings', currency: 'USD',
    items: [
      item({ type: 'stay', title: 'Hotel A', location: 'Paris', startDate: iso(30), endDate: iso(34), status: 'booked' }),
      item({ type: 'stay', title: 'Hotel B', location: 'Paris', startDate: iso(32), endDate: iso(36), status: 'booked' }),
      item({ title: 'Cancelled thing', location: 'Paris', startDate: iso(33), status: 'cancelled' }),
    ],
  });
  await withPage('tp-qa TP-10/13/23', { db: dbOf([warnTrip]) }, async (s) => {
    // TP-10: the row states its warning
    const badges = await evaluate(s, `(()=>[...document.querySelectorAll('#board .row-issue')]
      .map(b=>b.getAttribute('aria-label')))()`);
    await t('TP-10: a warned row carries a marker, not just a border colour',
      badges.length >= 2, `badges=${badges.length}`, s);
    await t('TP-10: the marker names the collision in words',
      badges.every(b => /Date collision/.test(b || '')) && /Hotel A/.test(badges[0] || ''),
      String(badges[0]).slice(0, 140), s);
    await t('TP-10: the marker is a real control, reachable by keyboard',
      await evaluate(s, `document.querySelector('#board .row-issue').tagName === 'BUTTON'`), '', s);

    // clicking it opens the full list
    await t('TP-10: the issues panel starts collapsed',
      (await evaluate(s, `document.querySelector('#issuesDetails').open`)) === false, '', s);
    await clickSel(s, '#board .row-issue');
    await waitForExpr(s, `document.querySelector('#issuesDetails').open === true`, { timeout: 4000 });
    await t('TP-10: the marker opens the panel listing every issue', true, '', s);

    // TP-13: the two counts agree about what they count
    const chip = await evaluate(s, `(()=>{const c=[...document.querySelectorAll('.summary .chip--items')][0];
      return c ? c.innerText.replace(/\\n/g,' ') : ''})()`);
    await t('TP-13: the Items chip discloses the cancelled item it excludes',
      /2 items/.test(chip) && /1 cancelled/.test(chip), chip, s);

    // TP-23: the delete confirm matches what undo guarantees
    await clickSel(s, '#selectBtn');
    await waitForExpr(s, `!!document.querySelector('#bulkAll')`, { timeout: 5000 });
    await evaluate(s, `(()=>{const c=document.querySelector('#bulkAll'); if(!c.checked) c.click(); return 1})()`);
    await waitForExpr(s, `/[2-9] selected/.test(document.querySelector('#bulkCount').textContent)`, { timeout: 5000 });
    await clickSel(s, '#bulkDelete');
    await waitForExpr(s, `document.querySelector('#confirmOverlay.overlay.open') !== null`, { timeout: 5000 });
    const dtext = await evaluate(s, `document.querySelector('#confirmText').textContent`);
    await t('TP-23: the delete confirm no longer claims to be permanent',
      !/permanently/i.test(dtext), dtext.slice(0, 160), s);
    await t('TP-23: it says undo works until a reload',
      /undo this until you reload/.test(dtext), dtext.slice(0, 200), s);
    await escape(s);
  });

  /* ============ TP-14 / TP-16 / TP-19: weather label and preferences ====== */
  freshIds();
  // Far enough out that the CLIMATE figure, not a near-term forecast, is the
  // answer for this day.
  const climateDay = iso(120);
  const climateTrip = trip({
    name: 'Climate', currency: 'USD',
    items: [item({ type: 'stay', title: 'Hotel', location: 'Rome', startDate: climateDay, endDate: iso(123), status: 'booked' })],
  });
  // Both caches SEEDED rather than canned over the wire: the archive request is
  // built from the day's own month, so a fixture payload has to agree with
  // whatever month `iso(120)` lands in - which is a fixture that rots. Seeding
  // the record the app would have stored tests the same rendering with none of
  // that. (The suite refuses every external host by default anyway.)
  const climateStores = {
    'trip-planner:geo:v3': { rome: { lat: 41.9028, lon: 12.4964, name: 'Rome', cc: 'IT', country: 'Italy', conf: 'confident' } },
    'trip-planner:weather:v2': {
      [`rome|${climateDay.slice(5, 7)}`]: { at: Date.now(), lo: 18, hi: 28, wet: false },
    },
  };
  await withPage('tp-qa TP-14/16/19', { db: dbOf([climateTrip]), stores: climateStores }, async (s) => {
    await switchView(s, 'days');
    // The FIRST chip carrying a temperature, and everything read off that same
    // element: a day grid holds one chip per day and only the located ones
    // paint, so querying `.dc-chip-tag` and `.dc-chip-temp` separately can land
    // on two different cards.
    const WEATHER_CHIP = `[...document.querySelectorAll('#daysList .dc-chip')]
      .find(c => { const v = c.querySelector('.dc-chip-temp'); return v && v.textContent.trim(); })`;
    const painted = await waitForExpr(s, `!!(${WEATHER_CHIP})`, { timeout: 15000 }).catch(() => false);
    if (painted === false) {
      await t('TP-14: a climate figure reaches the day chip', false, 'no day chip ever painted a temperature', s);
      return;
    }
    const chipState = () => evaluate(s, `(()=>{const c = ${WEATHER_CHIP};
      const tag = c.querySelector('.dc-chip-tag');
      return JSON.stringify({ temp: c.querySelector('.dc-chip-temp').textContent.trim(),
        tag: (tag && !tag.hidden) ? tag.textContent.trim() : '', title: c.title || '' })})()`);

    // TP-14: the caveat is on the chip, not only in a tooltip a phone cannot show
    const st1 = JSON.parse(await chipState());
    await t('TP-14: a climate figure is labelled "Typical" on the chip itself',
      st1.tag === 'Typical', JSON.stringify(st1), s);
    await t('TP-14: and the full caveat is still in the tooltip',
      /not a forecast/.test(st1.title), st1.title.slice(0, 140), s);

    // TP-19: the unit preference reaches the chip
    await t('TP-19: Celsius by default', /°C$/.test(st1.temp), st1.temp, s);
    await menuAct(s, 'tempunit');
    await waitForExpr(s, `/°F$/.test((${WEATHER_CHIP}).querySelector('.dc-chip-temp').textContent.trim())`, { timeout: 8000 });
    const st2 = JSON.parse(await chipState());
    await t('TP-19: switching to Fahrenheit converts the figure', st2.temp === '64-82°F', `${st1.temp} -> ${st2.temp}`, s);
    await t('TP-19: the choice is persisted like the other preferences',
      (await evaluate(s, `localStorage.getItem('trip-planner:tempunit')`)) === 'f', '', s);

    // TP-16: the preference rows expose their state
    await openMenu(s);
    const prefs = await evaluate(s, `(()=>['#timefmtBtn','#distunitBtn','#tempunitBtn'].map(sel=>{
      const b=document.querySelector(sel);
      return sel+'|'+b.getAttribute('role')+'|'+b.getAttribute('aria-checked')+'|'+b.textContent.trim()
    }).join(' ~ '))()`);
    await t('TP-16: each preference row is a checkbox with a state',
      prefs.split(' ~ ').every(p => /menuitemcheckbox/.test(p)), prefs.slice(0, 200), s);
    await t('TP-16: the row that is ON says so, visibly and programmatically',
      /#tempunitBtn\|menuitemcheckbox\|true\|✓/.test(prefs), prefs.slice(0, 220), s);
    await t('TP-16: and an OFF row is not ticked',
      /#timefmtBtn\|menuitemcheckbox\|false\|/.test(prefs) && !/#timefmtBtn\|menuitemcheckbox\|false\|✓/.test(prefs),
      prefs.slice(0, 220), s);
    await escape(s);
  });

  /* ============ TP-11: a single-stop map opens on the city ================ */
  freshIds();
  const oneStop = trip({
    name: 'One stop', currency: 'USD',
    items: [item({ title: 'Eiffel Tower', location: 'Paris', startDate: iso(40) })],
  });
  const parisNet = (url) => {
    if (/nominatim/.test(url)) {
      return { body: JSON.stringify([{ lat: '48.8566', lon: '2.3522', display_name: 'Paris, France', importance: 0.9, addresstype: 'city', address: { country_code: 'fr', country: 'France' } }]), contentType: 'application/json' };
    }
    if (/tile\.openstreetmap|unpkg|leaflet/.test(url)) return null;
    return /^https?:\/\/(localhost|127\.)/.test(url) ? null : 'fail';
  };
  await withPage('tp-qa TP-11', { db: dbOf([oneStop]), net: parisNet }, async (s) => {
    await switchView(s, 'map');
    const ok = await waitForExpr(s, `document.querySelectorAll('.leaflet-marker-icon').length === 1`, { timeout: 20000 }).catch(() => false);
    if (!ok) { await t('TP-11: the single stop is plotted', false, 'no marker appeared', s); return; }
    const zoom = await evaluate(s, `(()=>{const t=document.querySelector('.leaflet-tile');
      const m=t && /\\/(\\d+)\\/\\d+\\/\\d+\\.png/.exec(t.src); return m ? Number(m[1]) : null})()`);
    await t('TP-11: one stop opens at city zoom, not Leaflet maximum',
      zoom != null && zoom <= 12, `zoom=${zoom}`, s);
    // and the pin is actually on screen
    const inView = await evaluate(s, `(()=>{const box=document.querySelector('#mapBox').getBoundingClientRect();
      return [...document.querySelectorAll('.leaflet-marker-icon')].every(mk=>{const r=mk.getBoundingClientRect();
        return r.x>=box.x-40 && r.x<=box.x+box.width+40 && r.y>=box.y-40 && r.y<=box.y+box.height+40})})()`);
    await t('TP-11: and the pin is inside the visible map', inView === true, '', s);
  });

  /* ============ TP-06: a trip switch drops the old canvas ================= */
  freshIds();
  const tripA = trip({ name: 'Trip A', currency: 'USD', items: [
    item({ title: 'Louvre', location: 'Paris', startDate: iso(40) }),
    item({ title: 'Orsay', location: 'Lyon', startDate: iso(41) }),
  ] });
  const tripB = trip({ name: 'Trip B', currency: 'USD', items: [
    item({ title: 'Museum', location: 'Osaka', startDate: iso(60) }),
    item({ title: 'Castle', location: 'Nara', startDate: iso(61) }),
  ] });
  // Every geocode answers, but SLOWLY for trip B's cities, which is the window
  // the stale canvas used to live in.
  const slowNet = (url) => {
    if (/nominatim/.test(url)) {
      const q = decodeURIComponent(url).toLowerCase();
      const pin = /paris/.test(q) ? ['48.8566', '2.3522', 'Paris', 'fr']
        : /lyon/.test(q) ? ['45.76', '4.83', 'Lyon', 'fr']
          : /osaka/.test(q) ? ['34.69', '135.50', 'Osaka', 'jp']
            : /nara/.test(q) ? ['34.68', '135.80', 'Nara', 'jp'] : null;
      if (!pin) return { body: '[]', contentType: 'application/json' };
      return { body: JSON.stringify([{ lat: pin[0], lon: pin[1], display_name: pin[2], importance: 0.9, addresstype: 'city', address: { country_code: pin[3], country: pin[2] } }]), contentType: 'application/json' };
    }
    if (/tile\.openstreetmap|unpkg|leaflet/.test(url)) return null;
    return /^https?:\/\/(localhost|127\.)/.test(url) ? null : 'fail';
  };
  await withPage('tp-qa TP-06', { db: dbOf([tripA, tripB], tripA.id), net: slowNet }, async (s) => {
    await switchView(s, 'map');
    const ok = await waitForExpr(s, `document.querySelectorAll('.leaflet-marker-icon').length === 2`, { timeout: 25000 }).catch(() => false);
    if (!ok) { await t('TP-06: trip A is plotted', false, 'trip A never drew', s); return; }
    await t('TP-06: trip A is plotted', true, '', s);

    // switch trips and look IMMEDIATELY: the old canvas must already be gone
    await evaluate(s, `(()=>{const sel=document.querySelector('#tripSelect');
      const o=[...sel.options].find(o=>/Trip B/.test(o.text)); sel.value=o.value;
      sel.dispatchEvent(new Event('change',{bubbles:true})); return 1})()`);
    await sleep(250);
    const stale = await evaluate(s, `document.querySelectorAll('.leaflet-marker-icon').length`);
    await t('TP-06: the previous trip\'s pins are gone the moment the trip changes',
      stale === 0, `markers still on canvas: ${stale}`, s);

    // ...and the new trip eventually draws its own, in view
    const drew = await waitForExpr(s, `document.querySelectorAll('.leaflet-marker-icon').length === 2`, { timeout: 25000 }).catch(() => false);
    await t('TP-06: the new trip draws its own pins', drew !== false, '', s);
    if (drew !== false) {
      const inView = await evaluate(s, `(()=>{const box=document.querySelector('#mapBox').getBoundingClientRect();
        return [...document.querySelectorAll('.leaflet-marker-icon')].every(mk=>{const r=mk.getBoundingClientRect();
          return r.x>=box.x-60 && r.x<=box.x+box.width+60 && r.y>=box.y-60 && r.y<=box.y+box.height+60})})()`);
      await t('TP-06: and the map is fitted to them', inView === true, '', s);
    }
  });

  /* ============ TP-21: GPX resolves its own coordinates =================== */
  await withPage('tp-qa TP-21', { db: dbOf([tripA]), net: slowNet }, async (s) => {
    // deliberately never open the Map view: that was the hidden prerequisite
    const menu = await evaluate(s, `(()=>{const b=document.querySelector('#tripMenu button[data-act="export-gpx"]');
      return (b.getAttribute('aria-disabled')||'no') + '|' + (b.title||'')})()`);
    await t('TP-21: the export is offered without visiting the Map first',
      menu.startsWith('no'), menu.slice(0, 140), s);
    await t('TP-21: and its tooltip no longer sends the traveller to another view',
      !/open the Map view/i.test(menu), menu.slice(0, 140), s);

    // it downloads: assert the click reaches a real file rather than a dead end
    await evaluate(s, `(()=>{ window.__dl = null;
      const orig = URL.createObjectURL;
      URL.createObjectURL = (b) => { window.__dl = b.size; return orig.call(URL, b); };
      return 1 })()`);
    await menuAct(s, 'export-gpx', 300);
    const got = await waitForExpr(s, `window.__dl > 100`, { timeout: 25000 }).catch(() => false);
    await t('TP-21: clicking it produces a GPX file with both stops in it',
      got !== false, `blob size: ${await evaluate(s, 'window.__dl')}`, s);
  });

  /* ============ TP-12: the assistant opens on the free tier =============== */
  await withPage('tp-qa TP-12', { db: dbOf([standardTrip()]) }, async (s) => {
    await clickSel(s, '#assistBtn');
    await waitForExpr(s, `!!document.querySelector('#assistPanel .tier-opt.on')`, { timeout: 6000 });
    const on = await evaluate(s, `document.querySelector('#assistPanel .tier-opt.on').textContent.trim()`);
    await t('TP-12: a first-time traveller lands on the free one-click assistant',
      /Free assistant/.test(on), on.slice(0, 60), s);

    // an explicit choice still wins and is still remembered
    await evaluate(s, `(()=>{const r=[...document.querySelectorAll('#assistPanel input[name=assistTier]')]
      .find(x=>x.value==='copy'); r.click(); return 1})()`);
    await waitForExpr(s, `localStorage.getItem('trip-planner:assist:tier') === 'copy'`, { timeout: 5000 });
    await t('TP-12: choosing another tier is persisted', true, '', s);
  });

  /* ============ TP-15 / TP-18: the item form ============================== */
  // An EMPTY trip is where the form opens as a Flight (newItemType: the first
  // thing anyone logs is how they get there), which is the case TP-18 is about.
  await withPage('tp-qa TP-18 empty', { db: dbOf([trip({ name: 'Fresh', currency: 'USD', items: [] })]) }, async (s) => {
    await openAddItem(s);
    const focused = await evaluate(s, `document.activeElement && document.activeElement.id`);
    await t('TP-18: a new flight opens with the cursor in the first airport field',
      focused === 'inFlightFrom', `focus=${focused}`, s);
  });

  await withPage('tp-qa TP-15/18', { db: dbOf([standardTrip()]) }, async (s) => {
    await openAddItem(s);
    // On a trip that already holds items the form opens as an Activity, whose
    // own first field is the title - the flight pair is not on screen.
    const activityFocus = await evaluate(s, `document.activeElement && document.activeElement.id`);
    await t('TP-18: a non-flight type still opens on its own first field',
      activityFocus === 'inTitle', `focus=${activityFocus}`, s);
    // switching TO Flight moves the cursor to the pair it just revealed
    await evaluate(s, `(()=>{const b=[...document.querySelectorAll('#itemForm button')].find(x=>/Flight/.test(x.textContent)); b.click(); return 1})()`);
    await sleep(300);
    const flightFocus = await evaluate(s, `document.activeElement && document.activeElement.id`);
    await t('TP-18: choosing Flight moves the cursor to the airport pair',
      flightFocus === 'inFlightFrom', `focus=${flightFocus}`, s);

    // TP-15: the Book-by row follows the status
    await evaluate(s, `(()=>{const b=[...document.querySelectorAll('#itemForm button')].find(x=>/Activity/.test(x.textContent)); b.click(); return 1})()`);
    await sleep(300);
    const pending = await evaluate(s, `document.querySelector('#bookByHint').textContent`);
    await t('TP-15: while an item is still to book, the hint explains the reminder',
      /still "To book"/.test(pending), pending.slice(0, 120), s);
    await setValue(s, '#inStatus', 'booked');
    await evaluate(s, `document.querySelector('#inStatus').dispatchEvent(new Event('change',{bubbles:true}))`);
    await sleep(250);
    const booked = await evaluate(s, `document.querySelector('#bookByHint').textContent + '|' + document.querySelector('#inBookBy').disabled`);
    await t('TP-15: once Booked, the hint stops contradicting the status',
      /Already booked/.test(booked) && /\|true$/.test(booked), booked.slice(0, 140), s);
    await escape(s);
  });

  /* ============ TP-17: share explains before it copies ==================== */
  await withPage('tp-qa TP-17', { db: dbOf([standardTrip()]) }, async (s) => {
    await evaluate(s, `(()=>{ window.__copied = null;
      try { Object.defineProperty(navigator, 'clipboard', { configurable: true,
        value: { writeText: (v) => { window.__copied = v; return Promise.resolve(); } } }); } catch (e) {}
      return 1 })()`);
    await menuAct(s, 'share-trip', 500);
    await waitForExpr(s, `document.querySelector('#confirmOverlay.overlay.open') !== null`, { timeout: 6000 });
    await t('TP-17: nothing is on the clipboard while the notice is still up',
      (await evaluate(s, `window.__copied`)) === null, '', s);
    const text = await evaluate(s, `document.querySelector('#confirmText').textContent`);
    await t('TP-17: the notice says what the link carries, before copying',
      /confirmation numbers/.test(text) && /Anyone with the link can read them/.test(text), text.slice(0, 200), s);
    await clickSel(s, '#confirmYes');
    await waitForExpr(s, `typeof window.__copied === 'string' && window.__copied.includes('#share=')`, { timeout: 6000 });
    await t('TP-17: confirming copies the link', true, '', s);
  });

  /* ============ TP-09 / TP-22: the phone layout ========================== */
  freshIds();
  const phoneTrip = trip({
    name: 'Phone', currency: 'USD',
    items: [
      item({ type: 'stay', title: 'Hotel A', location: 'Paris', startDate: iso(30), endDate: iso(34), status: 'booked' }),
      item({ type: 'stay', title: 'Hotel B', location: 'Paris', startDate: iso(32), endDate: iso(36), status: 'booked' }),
    ],
  });
  for (const [w, h] of [[390, 844], [360, 780]]) {
    await withPage(`tp-qa TP-09 ${w}`, { db: dbOf([phoneTrip]), viewport: [w, h] }, async (s) => {
      const chip = await evaluate(s, `(()=>{const c=document.querySelector('.summary .chip--issues');
        if(!c) return 'missing';
        const r=c.getBoundingClientRect();
        return JSON.stringify({x:Math.round(r.x), w:Math.round(r.width), vw:window.innerWidth,
          visible: r.x >= -1 && r.x + r.width <= window.innerWidth + 1})})()`);
      const parsed = chip === 'missing' ? null : JSON.parse(chip);
      await t(`TP-09 @${w}: the Issues chip is on screen without scrolling`,
        !!parsed && parsed.visible === true, chip, s);
      await t(`TP-09 @${w}: the page itself never scrolls sideways`,
        await evaluate(s, `document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`),
        await evaluate(s, `document.documentElement.scrollWidth + ' vs ' + document.documentElement.clientWidth`), s);
      await screenshot(s, `${process.env.TP_QA_SHOTS || '/tmp'}/tp09-${w}.png`).catch(() => {});
    });
  }

  await withPage('tp-qa TP-22', { db: dbOf([trip({ name: 'Empty', currency: 'USD', items: [] })]), viewport: [390, 844] }, async (s) => {
    const cta = await evaluate(s, `(()=>{const b=document.querySelector('#emptyAdd');
      if(!b) return 'missing'; const r=b.getBoundingClientRect();
      return JSON.stringify({top: Math.round(r.top + window.scrollY), vh: window.innerHeight})})()`);
    const parsed = cta === 'missing' ? null : JSON.parse(cta);
    await t('TP-22: an empty trip shows its first-item button above the fold',
      !!parsed && parsed.top < parsed.vh, cta, s);
    await t('TP-22: and the example loader with it',
      await evaluate(s, `(()=>{const b=document.querySelector('#emptySample');
        return !!b && (b.getBoundingClientRect().top + window.scrollY) < window.innerHeight})()`), '', s);
    // the controls that need items are stood down, but Add item is not
    await t('TP-22: Add item is still offered',
      await evaluate(s, `document.querySelector('#addBtn').getBoundingClientRect().height > 0`), '', s);
    await t('TP-22: the view switcher is stood down until there is something to view',
      await evaluate(s, `document.querySelector('.view-switch').getBoundingClientRect().height === 0`), '', s);
  });

  /* ============ TP-03: the venue lookup is biased to the city ============= */
  freshIds();
  const biasTrip = trip({
    name: 'Bias', currency: 'USD',
    items: [item({ type: 'stay', title: 'Somewhere', location: 'Rome', startDate: iso(30), endDate: iso(33), status: 'booked' })],
  });
  const biasNet = (url) => {
    if (/nominatim/.test(url)) {
      return { body: JSON.stringify([{ lat: '41.9028', lon: '12.4964', display_name: 'Rome, Italy', importance: 0.9, addresstype: 'city', address: { country_code: 'it', country: 'Italy' } }]), contentType: 'application/json' };
    }
    if (/photon\.komoot\.io/.test(url)) {
      // record what the app ASKED for; the answer itself does not matter here
      return { body: JSON.stringify({ features: [] }), contentType: 'application/json' };
    }
    return /^https?:\/\/(localhost|127\.)/.test(url) ? null : 'fail';
  };
  await withPage('tp-qa TP-03', { db: dbOf([biasTrip]), net: biasNet }, async (s) => {
    // capture the photon URLs the page requests
    await evaluate(s, `(()=>{ window.__photon = [];
      const f = window.fetch;
      window.fetch = function(u, o){ try { const s=String(u&&u.url||u); if(/photon/.test(s)) window.__photon.push(s); } catch(e){}
        return f.apply(this, arguments); };
      return 1 })()`);
    await openAddItem(s);
    await evaluate(s, `(()=>{const b=[...document.querySelectorAll('#itemForm button')].find(x=>/Stay/.test(x.textContent)); b.click(); return 1})()`);
    await sleep(300);
    await setValue(s, '#inLocation', 'Rome');
    await evaluate(s, `document.querySelector('#inLocation').dispatchEvent(new Event('change',{bubbles:true}))`);
    // the city has to reach the geocode cache before the bias can use it
    await waitForExpr(s, `!!JSON.parse(localStorage.getItem('trip-planner:geo:v3')||'{}')['rome']`, { timeout: 15000 });
    await setValue(s, '#inTitle', 'Hotel Art');
    await evaluate(s, `document.querySelector('#inTitle').dispatchEvent(new Event('input',{bubbles:true}))`);
    const biased = await waitForExpr(s, `window.__photon.some(u=>/[?&]lat=/.test(u) && /[?&]lon=/.test(u))`, { timeout: 15000 }).catch(() => false);
    const urls = await evaluate(s, `window.__photon.join(' ~ ').slice(0,300)`);
    await t('TP-03: the hotel lookup carries the city coordinates as a bias',
      biased !== false, urls, s);
    await escape(s);
  });

  /* ============ TP-08: a refused rating says so ========================== */
  freshIds();
  const ratedTrip = trip({
    name: 'Rated', currency: 'USD',
    items: [item({ type: 'stay', title: 'Hotel', location: 'Bangkok', startDate: iso(30), endDate: iso(33), status: 'booked' })],
  });
  const day08 = iso(30);
  const REFUSED_REPLY = `One idea for the evening.

\`\`\`json
{"tripActions":[
 {"op":"add","item":{"type":"activity","title":"Drinks: Somewhere","location":"Bangkok","startDate":"${day08}","startTime":"20:00","mapsQuery":"Somewhere Bangkok"}}
]}
\`\`\``;
  // The endpoint RESOLVES the query and refuses it: exactly what the confidence
  // gate does for a landmark whose official name is not the one people type.
  const refusedNet = (url) => {
    if (/tp-places/.test(url)) {
      return { body: JSON.stringify({ results: [{ query: 'Somewhere Bangkok', status: 'no_match', reason: 'low_confidence' }], attribution: { text: 'Google Maps', url: 'https://www.google.com/maps' } }), contentType: 'application/json' };
    }
    return /^https?:\/\/(localhost|127\.)/.test(url) ? null : 'fail';
  };
  await withPage('tp-qa TP-08', { db: dbOf([ratedTrip]), net: refusedNet }, async (s) => {
    await clickSel(s, '#assistBtn');
    await waitForExpr(s, `!!document.querySelector('#assistTierGroup')`, { timeout: 6000 });
    // the paste box lives on the Copy & paste tier, which is no longer default
    await clickSel(s, '#assistTierGroup input[value="copy"]');
    await waitForExpr(s, `!!document.querySelector('#assistPasteBox')`, { timeout: 6000 });
    await setValue(s, '#assistPasteBox', REFUSED_REPLY);
    await clickSel(s, '#assistPasteParse');
    const carded = await waitForExpr(s, `document.querySelectorAll('#assistMessages .assist-proposal').length === 1`, { timeout: 10000 }).catch(() => false);
    if (carded === false) { await t('TP-08: the canned reply produced a card', false, 'no card rendered', s); return; }

    const settled = await waitForExpr(s, `(()=>{const el=document.querySelector('#assistMessages .ap-rating');
      return !!el && el.dataset.painted === '1'})()`, { timeout: 15000 }).catch(() => false);
    const state = await evaluate(s, `(()=>{const el=document.querySelector('#assistMessages .ap-rating');
      if(!el) return 'missing';
      return JSON.stringify({ text: el.textContent.trim(), cls: el.className,
        mapsLinkShown: !!(el.nextElementSibling && el.nextElementSibling.getBoundingClientRect().height > 0) })})()`);
    await t('TP-08: a refused match renders an explicit neutral state instead of nothing',
      settled !== false && /No rating match/.test(state), state.slice(0, 200), s);
    await t('TP-08: the refused slot is not marked as holding a rating',
      !/has-rating/.test(state), state.slice(0, 200), s);
    await t('TP-08: so the Google Maps link beside it survives',
      /"mapsLinkShown":true/.test(state), state.slice(0, 200), s);
  });

  return R;
}
