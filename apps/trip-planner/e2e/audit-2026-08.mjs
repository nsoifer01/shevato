// Trip Planner E2E: regression cover for the 2026-08-22 site-wide audit.
//   A. D1  deleting the only trip with a second tab open stays undoable
//          (the observing tab never writes a floor trip from its handler)
//   B. D2  trip delete keeps attached documents for the undo window; Undo
//          lands on the restored trip; a reload purges the orphans
//   C. D4  non-string startTime/confirmation/location are repaired at boot
//   D. D7  duplicate trip names get a hint; D8 the trip dialog focuses the
//          refused field
//   E. D9  axe (wcag2a/aa) over the open trip menu, the assistant panel and
//          the Route and Visa dialogs at 1280 and 390: zero serious/critical
//   F. D10 an unreachable geocoder is reported as such on the Map view
//   G. phone toolbar: first itinerary row on the first screen, More menu
//          proxies, one-tap stay expansion
//   H. per-day subtotal on the Days card header, with the unconverted cue
//   I. shift dialog validation and error clearing
//   J. focus lands on the saved row after an Enter-save
//   K. assistant wording for 404 / 500 / malformed 200
//   L. frankfurter non-JSON and base-mismatch bodies fall to the Retry note
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  recorder, freshIds, iso, item, trip, dbOf, standardTrip,
  openApp, openTab, readDb, overlayOpenId, toastText, tpErrors,
  menuAct, addItemViaUi, fillItem, openAddItem, switchView,
  closePage, evaluate, evalAsync, clickSel, setValue, pressKey, waitForExpr, sleep, escape,
} from './helpers.mjs';
import { EXTERNAL_HOSTS } from '../../../tests/browser/cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AXE_PATH = path.resolve(HERE, '..', '..', '..', 'tests', 'browser', 'vendor', 'axe.min.js');
const LS = 'trip-planner:v1';

const docCountExpr = `new Promise((res) => { const r = indexedDB.open('trip-planner-docs', 1);
  r.onupgradeneeded = () => { const st = r.result.createObjectStore('docs', { keyPath: 'id', autoIncrement: true }); st.createIndex('byItem', 'itemId'); };
  r.onsuccess = () => { const tx = r.result.transaction('docs'); const q = tx.objectStore('docs').count(); q.onsuccess = () => res(q.result); q.onerror = () => res(-1); };
  r.onerror = () => res(-1); })`;
const seedDocExpr = (itemId) => `new Promise((res, rej) => { const r = indexedDB.open('trip-planner-docs', 1);
  r.onupgradeneeded = () => { const st = r.result.createObjectStore('docs', { keyPath: 'id', autoIncrement: true }); st.createIndex('byItem', 'itemId'); };
  r.onsuccess = () => { const tx = r.result.transaction('docs', 'readwrite');
    tx.objectStore('docs').add({ itemId: ${JSON.stringify(itemId)}, name: 'ticket.pdf', type: 'application/pdf', size: 3, blob: new Blob(['abc']) });
    tx.oncomplete = () => res('ok'); tx.onerror = () => rej(tx.error); };
  r.onerror = () => rej(r.error); })`;

const SERIOUS = new Set(['serious', 'critical']);
async function axeSerious(s, axeSource) {
  await s.send('Runtime.evaluate', { expression: axeSource, returnByValue: false });
  const v = await evalAsync(s, `window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] }, resultTypes: ['violations'] })
    .then(r => r.violations.filter(x => ['serious','critical'].includes(x.impact)).map(x => x.id + ' @ ' + x.nodes.slice(0, 3).map(n => (n.target || []).join(' ')).join(', ')))`);
  return Array.isArray(v) ? v : ['axe did not run: ' + JSON.stringify(v)];
}

export async function run({ base, cdpPort }) {
  const R = [];
  const t = recorder(R);
  const axeSource = await readFile(AXE_PATH, 'utf8');

  /* ---------------- A. D1: delete the only trip with two tabs open ---------------- */
  let a = null, b = null;
  try {
    freshIds();
    const only = trip({ name: 'Only trip', items: [item({ title: 'Walk', startDate: iso(6) }), item({ title: 'Eat', startDate: iso(7) })] });
    a = await openApp(cdpPort, base, { db: dbOf([only]) });
    b = await openTab(cdpPort, base);
    await waitForExpr(b, `document.getElementById('tripSelect').selectedOptions[0].textContent.trim() === 'Only trip'`, { timeout: 6000 });
    await t('tp-audit A: tab-sync helper is loaded', await evaluate(a, `!!window.ShevatoTabSync`), '', a);
    await menuAct(a, 'delete-trip');
    await t('tp-audit A: the confirm promises an undo', /undo/i.test(await evaluate(a, `document.getElementById('confirmText').textContent`)), '', a);
    await clickSel(a, '#confirmYes', { settle: 800 });
    const bFloor = await waitForExpr(b, `document.getElementById('tripSelect').selectedOptions[0].textContent.trim() === 'My trip'`, { timeout: 6000 });
    await t('tp-audit A: tab B renders an empty floor trip after the delete', bFloor, '', b);
    await sleep(600); // a write from B's handler would land within this; nothing to wait for on a negative claim
    // The deleting tab's own render persists ITS floor trip (outsideHistory,
    // see ensureTrip); what must not happen is a second floor from B's
    // handler, which is the write that used to fire `storage` back into A.
    const stored = await readDb(a);
    await t('tp-audit A: storage holds exactly one empty floor trip (B did not write another)', stored && stored.trips.length === 1 && stored.trips[0].items.length === 0, JSON.stringify(stored && stored.trips.map(x => x.name)), b);
    await t('tp-audit A: Undo stays available in the deleting tab', !(await evaluate(a, `document.getElementById('undoBtn').disabled`)), '', a);
    await t('tp-audit A: no console errors in tab B (no refused write)', tpErrors(b).length === 0, tpErrors(b).slice(0, 2).join(' | '), b);
    await clickSel(a, '#undoBtn', { settle: 700 });
    const back = await readDb(a);
    await t('tp-audit A: Undo restores the trip in storage', back && back.trips.length === 1 && back.trips[0].name === 'Only trip' && back.trips[0].items.length === 2, JSON.stringify(back && back.trips.map(x => x.name)), a);
    await t('tp-audit A: the deleting tab shows the restored trip', await evaluate(a, `document.getElementById('tripSelect').selectedOptions[0].textContent.trim() === 'Only trip'`), '', a);
    const bBack = await waitForExpr(b, `document.getElementById('tripSelect').selectedOptions[0].textContent.trim() === 'Only trip' && document.getElementById('board').innerText.includes('Walk')`, { timeout: 6000 });
    await t('tp-audit A: tab B renders the restored trip', bBack, '', b);
    await t('tp-audit A: no page errors in tab A', tpErrors(a).length === 0, tpErrors(a).slice(0, 2).join(' | '), a);
  } catch (e) {
    await t('tp-audit A: block ran', false, String(e && e.message).slice(0, 140), a);
  } finally {
    if (a) try { await closePage(cdpPort, a); } catch { /* gone */ }
    if (b) try { await closePage(cdpPort, b); } catch { /* gone */ }
  }

  /* ---------------- B. D2: documents survive the undo window ---------------- */
  let s = null;
  try {
    freshIds();
    const it1 = item({ type: 'flight', title: 'A to B', startDate: iso(5), cost: 100 });
    const docs = trip({ name: 'Docs trip', items: [it1, item({ title: 'Walk', startDate: iso(6) })] });
    const other = trip({ name: 'Other trip', items: [item({ title: 'Thing', startDate: iso(40) })] });
    s = await openApp(cdpPort, base, { db: dbOf([docs, other], docs.id) });
    await evalAsync(s, seedDocExpr(it1.id));
    await t('tp-audit B: a document is seeded', (await evalAsync(s, docCountExpr)) === 1, '', s);
    await menuAct(s, 'delete-trip');
    const confirm = await evaluate(s, `document.getElementById('confirmText').textContent`);
    await t('tp-audit B: the confirm states what happens to documents', /document/i.test(confirm) && /reload/i.test(confirm), confirm, s);
    await clickSel(s, '#confirmYes', { settle: 900 });
    await t('tp-audit B: the trip is gone', (await readDb(s)).trips.length === 1, '', s);
    await t('tp-audit B: its documents are kept while the delete is undoable', (await evalAsync(s, docCountExpr)) === 1, '', s);
    await clickSel(s, '#undoBtn', { settle: 700 });
    const db = await readDb(s);
    await t('tp-audit B: Undo restores the trip with its items', db.trips.some(x => x.id === docs.id && x.items.length === 2), '', s);
    await t('tp-audit B: ...and the document is still attached', (await evalAsync(s, docCountExpr)) === 1, '', s);
    await t('tp-audit B: Undo lands on the restored trip', await evaluate(s, `document.getElementById('tripSelect').selectedOptions[0].textContent.trim() === 'Docs trip'`), '', s);
    // delete again, reload: the undo window closed, the orphans go
    await menuAct(s, 'delete-trip');
    await clickSel(s, '#confirmYes', { settle: 900 });
    await evaluate(s, `location.reload()`);
    await waitForExpr(s, `window.__TP_BUILD && !!document.querySelector('#board')`, { timeout: 12000 });
    const purged = await waitForExpr(s, `(${docCountExpr}).then(n => n === 0)`, { timeout: 6000 }).catch(() => false);
    await t('tp-audit B: a reload after the delete purges the orphaned documents', purged === true, '', s);
    await t('tp-audit B: no page errors', tpErrors(s).length === 0, tpErrors(s).slice(0, 2).join(' | '), s);
  } catch (e) {
    await t('tp-audit B: block ran', false, String(e && e.message).slice(0, 140), s);
  } finally {
    if (s) try { await closePage(cdpPort, s); } catch { /* gone */ }
  }

  /* ---------------- C. D4: repairTrips coerces the string fields ---------------- */
  s = null;
  try {
    freshIds();
    const junk = trip({ name: 'Junk trip', items: [
      item({ title: 'Bad time', startDate: iso(10), startTime: 25 }),
      item({ title: 'Bad code', startDate: iso(10), confirmation: 99 }),
      item({ type: 'stay', title: 'Bad place', location: 12, startDate: iso(10), endDate: iso(12) }),
    ] });
    s = await openApp(cdpPort, base, { db: dbOf([junk]) });
    await t('tp-audit C: Timeline renders, no error boundary', await evaluate(s, `!document.body.innerText.includes('Something went wrong') && document.querySelectorAll('#board .tp-row').length >= 1`), '', s);
    const fixed = (await readDb(s)).trips[0].items;
    await t('tp-audit C: the junk fields are repaired to strings in storage',
      fixed.every(x => typeof x.startTime === 'string' && typeof x.confirmation === 'string' && typeof x.location === 'string'), JSON.stringify(fixed.map(x => [x.startTime, x.confirmation, x.location])), s);
    await switchView(s, 'days');
    await t('tp-audit C: Days view renders the repaired trip', await evaluate(s, `document.querySelectorAll('#daysList .day-card').length >= 3`), '', s);
    await t('tp-audit C: no page errors', tpErrors(s).length === 0, tpErrors(s).slice(0, 2).join(' | '), s);
  } catch (e) {
    await t('tp-audit C: block ran', false, String(e && e.message).slice(0, 140), s);
  } finally {
    if (s) try { await closePage(cdpPort, s); } catch { /* gone */ }
  }

  /* ---------------- D. D7 duplicate names, D8 focus on the refused field ---------------- */
  s = null;
  try {
    freshIds();
    s = await openApp(cdpPort, base, { db: dbOf([trip({ name: 'Feat trip', items: [item({ title: 'X', startDate: iso(9) })] })]) });
    await menuAct(s, 'new-trip');
    await t('tp-audit D: the New trip dialog opens', (await overlayOpenId(s)) === 'tripOverlay', '', s);
    await setValue(s, '#inTripName', 'feat TRIP');
    await evaluate(s, `document.getElementById('inTripName').dispatchEvent(new Event('input', { bubbles: true }))`);
    const hint = await evaluate(s, `(()=>{const h=document.getElementById('tripNameHint'); return h.hidden ? '' : h.textContent})()`);
    await t('tp-audit D: a duplicate name (case-insensitive) gets a hint with a suffix suggestion', /already/i.test(hint) && /\(2\)/.test(hint), hint, s);
    await setValue(s, '#inTripName', '   ');
    await clickSel(s, '#tripSaveBtn', { settle: 300 });
    await t('tp-audit D: a blank name keeps the dialog open', (await overlayOpenId(s)) === 'tripOverlay', '', s);
    await t('tp-audit D: ...and focuses the name field', (await evaluate(s, `document.activeElement && document.activeElement.id`)) === 'inTripName', '', s);
    await setValue(s, '#inTripName', 'Budget trip');
    await setValue(s, '#inTripBudgetFrom', '500');
    await setValue(s, '#inTripBudgetTo', '100');
    await clickSel(s, '#tripSaveBtn', { settle: 300 });
    await t('tp-audit D: a floor above the ceiling focuses the budget field', /^inTripBudget/.test(await evaluate(s, `document.activeElement && document.activeElement.id`) || ''), await evaluate(s, `document.activeElement && document.activeElement.id`), s);
    await t('tp-audit D: no page errors', tpErrors(s).length === 0, tpErrors(s).slice(0, 2).join(' | '), s);
  } catch (e) {
    await t('tp-audit D: block ran', false, String(e && e.message).slice(0, 140), s);
  } finally {
    if (s) try { await closePage(cdpPort, s); } catch { /* gone */ }
  }

  /* ---------------- E. D9: axe over the seeded interactive states ---------------- */
  for (const vp of [[1280, 900], [390, 844]]) {
    s = null;
    const tag = `${vp[0]}`;
    try {
      freshIds();
      s = await openApp(cdpPort, base, { db: dbOf([standardTrip(30, { name: 'Axe trip' })]), viewport: vp });
      await clickSel(s, '#tripMenuBtn', { settle: 350 });
      let v = await axeSerious(s, axeSource);
      await t(`tp-audit E: open trip menu has no serious/critical axe violations (${tag})`, v.length === 0, v.join(' ; '), s);
      await escape(s);
      await clickSel(s, '#assistBtn', { settle: 600 });
      await waitForExpr(s, `!document.getElementById('assistPanel').hidden`, { timeout: 4000 });
      v = await axeSerious(s, axeSource);
      await t(`tp-audit E: assistant panel has no serious/critical axe violations (${tag})`, v.length === 0, v.join(' ; '), s);
      await clickSel(s, '#assistCloseBtn', { settle: 300 });
      // the phone folds #routeBtn/#visaBtn behind More (block G proves the
      // proxy); here the real control is clicked directly in both layouts
      await evaluate(s, `document.getElementById('routeBtn').click()`); await sleep(500);
      await t(`tp-audit E: Route dialog opens (${tag})`, (await overlayOpenId(s)) === 'routeOverlay', '', s);
      v = await axeSerious(s, axeSource);
      await t(`tp-audit E: Route dialog has no serious/critical axe violations (${tag})`, v.length === 0, v.join(' ; '), s);
      await escape(s);
      await evaluate(s, `document.getElementById('visaBtn').click()`); await sleep(800);
      await t(`tp-audit E: Visa dialog opens (${tag})`, (await overlayOpenId(s)) === 'visaOverlay', '', s);
      v = await axeSerious(s, axeSource);
      await t(`tp-audit E: Visa dialog has no serious/critical axe violations (${tag})`, v.length === 0, v.join(' ; '), s);
      await escape(s);
      if (vp[0] < 700) {
        v = await axeSerious(s, axeSource);
        await t('tp-audit E: phone Timeline (summary scroller) has no serious/critical axe violations', v.length === 0, v.join(' ; '), s);
      }
    } catch (e) {
      await t(`tp-audit E: block ran (${tag})`, false, String(e && e.message).slice(0, 140), s);
    } finally {
      if (s) try { await closePage(cdpPort, s); } catch { /* gone */ }
    }
  }

  /* ---------------- F. D10: unreachable geocoder on the Map view ---------------- */
  s = null;
  try {
    freshIds();
    s = await openApp(cdpPort, base, { db: dbOf([standardTrip(30, { name: 'Map trip' })]) }); // nominatim refused by default
    await switchView(s, 'map', 1500);
    const text = await waitForExpr(s, `(()=>{const m=document.getElementById('mapStatus'); return m && /could not be reached|offline/i.test(m.innerText)})()`, { timeout: 15000 });
    const shown = await evaluate(s, `document.getElementById('mapStatus').innerText`);
    await t('tp-audit F: an unreachable lookup is reported as such, not as bad place names', text && !/Try more specific place names/.test(shown), shown.slice(0, 160), s);
  } catch (e) {
    await t('tp-audit F: block ran', false, String(e && e.message).slice(0, 140), s);
  } finally {
    if (s) try { await closePage(cdpPort, s); } catch { /* gone */ }
  }

  /* ---------------- G. phone toolbar and stay groups ---------------- */
  s = null;
  try {
    freshIds();
    s = await openApp(cdpPort, base, { db: dbOf([standardTrip(30, { name: 'Phone trip' })]), viewport: [390, 844] });
    await t('tp-audit G: no horizontal overflow at 390', await evaluate(s, `document.documentElement.scrollWidth <= document.documentElement.clientWidth`), '', s);
    const firstRowTop = await evaluate(s, `(()=>{const r=document.querySelector('#board .tp-row'); return r ? Math.round(r.getBoundingClientRect().top) : -1})()`);
    await t('tp-audit G: the first itinerary row is on the first screen at 390', firstRowTop > 0 && firstRowTop + 40 <= 844, `top=${firstRowTop}`, s);
    await t('tp-audit G: the secondary tools are folded behind More', await evaluate(s, `(()=>{const m=document.getElementById('tbMoreBtn'); const r=document.getElementById('routeBtn'); return m.offsetParent !== null && r.offsetParent === null})()`), '', s);
    await clickSel(s, '#tbMoreBtn', { settle: 300 });
    await t('tp-audit G: More opens its menu', await evaluate(s, `!document.getElementById('tbMoreMenu').hidden`), '', s);
    await clickSel(s, '#tbMoreMenu [data-proxy="#routeBtn"]', { settle: 500 });
    await t('tp-audit G: a More row proxies to the real control (Route opens)', (await overlayOpenId(s)) === 'routeOverlay', '', s);
    await escape(s);
    await clickSel(s, '#tbMoreBtn', { settle: 300 });
    await clickSel(s, '#tbMoreMenu [data-act="toggle-filters"]', { settle: 300 });
    await t('tp-audit G: Search and filters reveals the filter row', await evaluate(s, `document.getElementById('searchBox').offsetParent !== null`), '', s);
    // one-tap stay expansion: the stay toggle opens the days inside it too
    const stayOpened = await clickSel(s, '.tl-stay-toggle[aria-expanded="false"]', { settle: 400 });
    await t('tp-audit G: a collapsed stay exists to expand', !!stayOpened, '', s);
    await t('tp-audit G: one tap on a stay shows its rows (no second collapsed layer)', await evaluate(s, `(()=>{const k=document.querySelector('.tl-stay.is-open .tl-kids'); return !!k && !k.hidden && !!k.querySelector('.tl-day-items:not([hidden]) .tp-row') && !k.querySelector('.tl-day-toggle[aria-expanded="false"]')})()`), '', s);
    await t('tp-audit G: no page errors', tpErrors(s).length === 0, tpErrors(s).slice(0, 2).join(' | '), s);
  } catch (e) {
    await t('tp-audit G: block ran', false, String(e && e.message).slice(0, 140), s);
  } finally {
    if (s) try { await closePage(cdpPort, s); } catch { /* gone */ }
  }

  /* ---------------- H. per-day subtotal ---------------- */
  s = null;
  try {
    freshIds();
    const spend = trip({ name: 'Spend trip', currency: 'USD', items: [
      item({ title: 'Museum', startDate: iso(20), startTime: '10:00', status: 'booked', cost: 60, costCurrency: 'USD' }),
      item({ title: 'Lunch', startDate: iso(20), status: 'booked', cost: 15, costCurrency: 'USD' }),
      item({ title: 'Maybe', startDate: iso(20), status: 'to-book', cost: 999, costCurrency: 'USD' }),
      item({ title: 'Odd money', startDate: iso(21), status: 'booked', cost: 10, costCurrency: 'XYZ' }),
      item({ title: 'Free walk', startDate: iso(22), status: 'booked' }),
    ] });
    s = await openApp(cdpPort, base, { db: dbOf([spend]) });
    await switchView(s, 'days');
    const d1 = await evaluate(s, `(()=>{const c=document.querySelector('.day-card[data-date="${iso(20)}"] .dc-spend'); return c ? c.textContent.replace(/\\s+/g,' ').trim() : null})()`);
    await t('tp-audit H: the Days header totals the day\'s booked costs only', d1 !== null && /75/.test(d1) && !/999/.test(d1), String(d1), s);
    const d2 = await evaluate(s, `(()=>{const c=document.querySelector('.day-card[data-date="${iso(21)}"] .dc-spend'); return c ? c.textContent.replace(/\\s+/g,' ').trim() : null})()`);
    await t('tp-audit H: an unconvertible amount is counted out loud', d2 !== null && /not converted/.test(d2), String(d2), s);
    await t('tp-audit H: a day with no money shows no subtotal', await evaluate(s, `!document.querySelector('.day-card[data-date="${iso(22)}"] .dc-spend')`), '', s);
  } catch (e) {
    await t('tp-audit H: block ran', false, String(e && e.message).slice(0, 140), s);
  } finally {
    if (s) try { await closePage(cdpPort, s); } catch { /* gone */ }
  }

  /* ---------------- I. shift validation and error clearing ---------------- */
  s = null;
  try {
    freshIds();
    s = await openApp(cdpPort, base, { db: dbOf([standardTrip(30, { name: 'Shift trip' })]) });
    const shift = async (v) => {
      await clickSel(s, '#shiftTripBtn', { settle: 250 });
      await setValue(s, '#shiftDays', v);
      await clickSel(s, '#shiftForm button[type=submit]', { settle: 400 });
      return { err: await evaluate(s, `document.getElementById('shiftErr').textContent`), open: (await overlayOpenId(s)) === 'shiftOverlay', invalid: await evaluate(s, `document.getElementById('fShiftDays').classList.contains('invalid')`) };
    };
    let r = await shift('0');
    await t('tp-audit I: a 0-day shift is refused with a message', r.open && r.invalid && /0 days/.test(r.err), JSON.stringify(r), s);
    await escape(s);
    r = await shift('2.5');
    await t('tp-audit I: a fractional shift is refused', r.open && /whole number/.test(r.err), JSON.stringify(r), s);
    await escape(s);
    r = await shift('1e9');
    await t('tp-audit I: an absurd shift is refused', r.open && /calendar/.test(r.err), JSON.stringify(r), s);
    await escape(s);
    r = await shift('3');
    await t('tp-audit I: a valid shift closes the dialog', !r.open, JSON.stringify(r), s);
    await clickSel(s, '#shiftTripBtn', { settle: 250 });
    const stale = await evaluate(s, `({ err: document.getElementById('shiftErr').textContent, invalid: document.getElementById('fShiftDays').classList.contains('invalid') })`);
    await t('tp-audit I: reopening the dialog shows no stale error', !stale.invalid && stale.err === '', JSON.stringify(stale), s);
    await escape(s);
  } catch (e) {
    await t('tp-audit I: block ran', false, String(e && e.message).slice(0, 140), s);
  } finally {
    if (s) try { await closePage(cdpPort, s); } catch { /* gone */ }
  }

  /* ---------------- J. focus after an Enter-save ---------------- */
  s = null;
  try {
    freshIds();
    s = await openApp(cdpPort, base, { db: dbOf([trip({ name: 'Focus trip', items: [item({ title: 'Seed', startDate: iso(9), startTime: '09:00' })] })]) });
    await openAddItem(s);
    await fillItem(s, { type: 'activity', title: 'Enter saved', start: iso(9), time: '12:00' });
    await evaluate(s, `document.getElementById('inTitle').focus()`);
    await pressKey(s, 'Enter', 'Enter', 13, 0, '\r'); // the text is what makes it an implicit submit
    await waitForExpr(s, `!document.getElementById('itemOverlay').classList.contains('open')`, { timeout: 4000 });
    await sleep(300);
    const where = await evaluate(s, `(()=>{const el=document.activeElement; if(!el||el===document.body) return 'body'; const row=el.closest('.tp-row'); return row ? 'row:' + row.querySelector('.title, .tp-title, [class*=title]')?.textContent.trim().slice(0,20) : el.id || el.tagName})()`);
    await t('tp-audit J: after an Enter-save focus is on the saved row, never on <body>', where !== 'body' && /^row:/.test(where), where, s);
  } catch (e) {
    await t('tp-audit J: block ran', false, String(e && e.message).slice(0, 140), s);
  } finally {
    if (s) try { await closePage(cdpPort, s); } catch { /* gone */ }
  }

  /* ---------------- K. assistant wording ---------------- */
  for (const [mode, expect] of [['404', /could not answer right now/], ['500', /could not answer right now/], ['malformed', /unreadable/]]) {
    s = null;
    try {
      freshIds();
      const net = (u) => {
        if (/tp-assist/.test(u)) {
          if (mode === '404') return { status: 404, body: 'Not found', contentType: 'text/plain' };
          if (mode === '500') return { status: 500, body: { error: 'boom' } };
          return { body: '{not json', contentType: 'application/json' };
        }
        return EXTERNAL_HOSTS.test(u) ? 'fail' : null;
      };
      s = await openApp(cdpPort, base, { db: dbOf([standardTrip(30, { name: 'Assist trip' })]), net });
      await clickSel(s, '#assistBtn', { settle: 600 });
      await evaluate(s, `(()=>{const r=document.querySelector('#assistTierGroup input[value="site"]'); if (r && !r.checked) r.click(); return 1})()`);
      await setValue(s, '#assistInput', 'Plan my day');
      await clickSel(s, '#assistSend', { settle: 300 });
      const got = await waitForExpr(s, `!!document.querySelector('#assistMessages .assist-error')`, { timeout: 8000 });
      const text = got ? await evaluate(s, `document.querySelector('#assistMessages .assist-error').textContent`) : '';
      await t(`tp-audit K: assistant ${mode} is worded honestly`, expect.test(text) && !/check your connection/.test(text), text, s);
    } catch (e) {
      await t(`tp-audit K: block ran (${mode})`, false, String(e && e.message).slice(0, 140), s);
    } finally {
      if (s) try { await closePage(cdpPort, s); } catch { /* gone */ }
    }
  }

  /* ---------------- L. frankfurter bodies ---------------- */
  for (const [mode, body] of [['non-JSON', { body: '<html>oops', contentType: 'text/html' }], ['base mismatch', { body: { amount: 1, base: 'EUR', date: '2026-08-21', rates: { USD: 1.1, GBP: 0.85 } } }]]) {
    s = null;
    try {
      freshIds();
      const money = trip({ name: 'Money trip', currency: 'USD', items: [item({ title: 'Hotel', type: 'stay', startDate: iso(20), endDate: iso(22), status: 'booked', cost: 600, costCurrency: 'EUR' })] });
      s = await openApp(cdpPort, base, { db: dbOf([money]), net: (u) => (/frankfurter/.test(u) ? body : (EXTERNAL_HOSTS.test(u) ? 'fail' : null)) });
      const shown = await waitForExpr(s, `!!document.getElementById('ratesRetryBtn')`, { timeout: 8000 });
      const note = await evaluate(s, `(()=>{const n=document.querySelector('.totals-note'); return n ? n.textContent : ''})()`);
      await t(`tp-audit L: a ${mode} rates body falls to the honest note with Retry`, shown && /Could not fetch/.test(note), note.slice(0, 160), s);
      await t(`tp-audit L: ...and nothing bad is cached (${mode})`, await evaluate(s, `(()=>{try{const r=JSON.parse(localStorage.getItem('trip-planner:rates:v1')||'null'); return !r || r.base === 'USD'}catch(e){return false}})()`), '', s);
    } catch (e) {
      await t(`tp-audit L: block ran (${mode})`, false, String(e && e.message).slice(0, 140), s);
    } finally {
      if (s) try { await closePage(cdpPort, s); } catch { /* gone */ }
    }
  }

  return R;
}
