// Shared fixtures and drivers for the trip-planner E2E suites.
//
// Everything here follows the app's own architecture (see FINDINGS.md):
//   - App state is closure-scoped and read at boot, so tests SEED
//     `trip-planner:v1` in localStorage and reload; they never poke internal
//     JS state from outside.
//   - All external providers are blocked by default (interceptNetwork), so a
//     suite is deterministic and never depends on photon/open-meteo/frankfurter
//     being up. A test that needs a canned response passes its own rules.
//   - Assertions read what a user can read: the DOM, localStorage, toasts.
//
// Failure artifacts: recorder() captures a screenshot of the failing page into
// .screenshots/e2e-trip-planner/ (gitignored). Successful runs write nothing.
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  newPage, closePage, goto, evaluate, evalAsync, waitForExpr, clickSel,
  setValue, pressKey, setViewport, screenshot, sleep, cleanErrors,
  interceptNetwork, EXTERNAL_HOSTS,
} from '../../../tests/browser/cdp.mjs';

export const APP = '/apps/trip-planner/';
export const LS_KEY = 'trip-planner:v1';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const ART_DIR = path.join(REPO, '.screenshots', 'e2e-trip-planner');

// ---------------------------------------------------------------------------
// Result recording with screenshot-on-failure.
export function recorder(R) {
  return async (name, pass, detail = '', s = null) => {
    R.push({ name, pass: !!pass, detail: detail ? String(detail).slice(0, 180) : '' });
    if (!pass && s) {
      try {
        await mkdir(ART_DIR, { recursive: true });
        const file = path.join(ART_DIR, name.replace(/[^a-z0-9_-]+/gi, '_').slice(0, 80) + '.png');
        await screenshot(s, file);
        const last = R[R.length - 1];
        last.detail = (last.detail ? last.detail + ' ' : '') + `[shot: ${path.relative(REPO, file)}]`;
      } catch { /* a failed artifact never masks the failure itself */ }
    }
  };
}

// ---------------------------------------------------------------------------
// Deterministic fixture data. Dates are relative to today so warnings that
// depend on past/future keep meaning the same thing on every run.
let uidN = 0;
export const freshIds = () => { uidN = 0; };
const uid = () => `e2e-${String(++uidN).padStart(3, '0')}`;

export function iso(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function item(over = {}) {
  return {
    id: uid(), type: 'activity', title: 'Untitled', location: '', startDate: iso(30),
    endDate: '', startTime: '', endTime: '', status: 'booked', cost: null,
    costNote: '', confirmation: '', bookBy: '', details: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

export function trip(over = {}) {
  return { id: uid(), name: 'E2E trip', currency: 'USD', items: [], ...over };
}

export function dbOf(trips, activeId) {
  return { version: 1, activeTripId: activeId || (trips[0] && trips[0].id) || null, trips };
}

// The standard rich trip most suites seed: two cities, both stay styles, an
// overnight flight, timed + untimed + cancelled items, full night coverage
// (warning-free by construction; the warnings suite builds its own broken one).
export function standardTrip(base = 30, over = {}) {
  return trip({
    name: 'Japan E2E',
    items: [
      item({ type: 'flight', title: 'Shreveport (SHV) to Tokyo (HND)', startDate: iso(base), startTime: '08:00', endDate: iso(base + 1), endTime: '14:25', status: 'booked', cost: 900, costCurrency: 'USD', confirmation: 'XJ7K2Q' }),
      item({ type: 'stay', title: 'Tokyo Grand Hotel', location: 'Tokyo', startDate: iso(base + 1), endDate: iso(base + 4), status: 'booked', cost: 450, costCurrency: 'USD' }),
      item({ type: 'local', title: 'Airport Limousine Bus', location: 'Tokyo', startDate: iso(base + 1), startTime: '16:30', status: 'to-book' }),
      item({ type: 'activity', title: 'Sushi making class', location: 'Tokyo', startDate: iso(base + 2), startTime: '11:00', status: 'to-book', cost: 60, costCurrency: 'USD' }),
      item({ type: 'note', title: 'Buy JR Pass', startDate: iso(base + 3) }),
      item({ type: 'transport', title: 'Tokyo to Kyoto', location: 'Kyoto', startDate: iso(base + 4), startTime: '09:15', status: 'booked', cost: 110, costCurrency: 'USD' }),
      item({ type: 'stay', title: 'Kyoto Ryokan', location: 'Kyoto', startDate: iso(base + 4), endDate: iso(base + 6), status: 'to-book', cost: 320, costCurrency: 'USD' }),
      item({ type: 'activity', title: 'Golden Pavilion', location: 'Kyoto', startDate: iso(base + 5), startTime: '10:00', status: 'cancelled' }),
    ],
    ...over,
  });
}

// ---------------------------------------------------------------------------
// Page lifecycle.
//
// Default network rule: refuse every external provider, let the local static
// server through. Pass net: null to disable interception, or a function
// (url, request) => verdict for canned responses (see cdp.mjs interceptNetwork).
const defaultNet = (url) => (EXTERNAL_HOSTS.test(url) ? 'fail' : null);

async function clearTpStorage(s) {
  await evaluate(s, `(()=>{ try{
    for (const k of Object.keys(localStorage)) if (k.startsWith('trip-planner:')) localStorage.removeItem(k);
    sessionStorage.clear();
  } catch(e){} return 1 })()`);
}

export async function waitReady(s, timeout = 12000) {
  return waitForExpr(s, `window.__TP_BUILD && !!document.querySelector('#board')`, { timeout });
}

// A navigation that ALWAYS re-boots the app. Page.navigate from the app to the
// same URL with a different fragment is treated as a hash change, so boot-time
// paths (share links, deep-linked views) silently do not run; bouncing through
// about:blank forces a real load.
export async function gotoHard(s, url, { settle = 1000 } = {}) {
  await goto(s, 'about:blank', { settle: 150 });
  await goto(s, url, { settle });
  return waitReady(s);
}

// Fresh page on the app with storage reset to exactly `db` (or empty). The
// double navigation matters: storage can only be touched on the app's origin,
// and app state is read at boot, so seed THEN reload.
export async function openApp(cdpPort, base, { db = null, hash = '', viewport = [1280, 900], net = defaultNet, settle = 900 } = {}) {
  const s = await newPage(cdpPort);
  await setViewport(s, viewport[0], viewport[1], viewport[0] < 700);
  if (net) await interceptNetwork(s, net);
  await goto(s, base + APP, { settle: 600 });
  await clearTpStorage(s);
  if (db) await evaluate(s, `(()=>{ localStorage.setItem(${JSON.stringify(LS_KEY)}, ${JSON.stringify(JSON.stringify(db))}); return 1 })()`);
  await goto(s, base + APP + hash, { settle });
  await waitReady(s);
  return s;
}

// Second tab onto the SAME storage: no clearing, no seeding.
export async function openTab(cdpPort, base, { hash = '', viewport = [1280, 900], net = defaultNet, settle = 900 } = {}) {
  const s = await newPage(cdpPort);
  await setViewport(s, viewport[0], viewport[1], viewport[0] < 700);
  if (net) await interceptNetwork(s, net);
  await goto(s, base + APP + hash, { settle });
  await waitReady(s);
  return s;
}

// ---------------------------------------------------------------------------
// Reading state back.
export const readDb = (s) => evaluate(s, `JSON.parse(localStorage.getItem(${JSON.stringify(LS_KEY)}) || 'null')`);
export async function activeTripOf(s) {
  const db = await readDb(s);
  if (!db || !Array.isArray(db.trips)) return null;
  return db.trips.find((t) => t.id === db.activeTripId) || null;
}
export const rowCount = (s) => evaluate(s, `document.querySelectorAll('#board .tp-row').length`);
export const overlayOpenId = (s) => evaluate(s, `(()=>{const o=[...document.querySelectorAll('.overlay.open')]; return o.length? o[o.length-1].id : null})()`);
export const toastText = (s) => evaluate(s, `[...document.querySelectorAll('#toasts .toast')].map(t=>t.textContent).join(' | ')`);
export const tpErrors = cleanErrors;

// ---------------------------------------------------------------------------
// UI drivers.
export async function openMenu(s) {
  if (await evaluate(s, `document.getElementById('tripMenu').classList.contains('open')`)) return true;
  await clickSel(s, '#tripMenuBtn', { settle: 350 });
  return evaluate(s, `document.getElementById('tripMenu').classList.contains('open')`);
}
export async function menuAct(s, act, settle = 600) {
  await openMenu(s);
  return clickSel(s, `.tp-menu-panel [data-act="${act}"]`, { settle });
}
export const menuState = (s) => evaluate(s, `Object.fromEntries([...document.querySelectorAll('.tp-menu-panel [data-act]')].map(b=>[b.dataset.act, b.disabled]))`);

export async function openAddItem(s) {
  await clickSel(s, '#addBtn', { settle: 400 });
  return evaluate(s, `document.getElementById('itemOverlay').classList.contains('open')`);
}

// Fills the item form. Only the fields passed are touched.
export async function fillItem(s, f) {
  if (f.type) await clickSel(s, `#typePicker [data-type="${f.type}"]`, { settle: 250 });
  const map = {
    title: '#inTitle', place: '#inLocation', start: '#inStart', end: '#inEnd',
    time: '#inTime', arrDate: '#inArrDate', arrTime: '#inArrTime', status: '#inStatus',
    cost: '#inCost', currency: '#inCostCurrency', costNote: '#inCostNote',
    confirmation: '#inConfirmation', bookBy: '#inBookBy', details: '#inDetails',
  };
  for (const [k, sel] of Object.entries(map)) {
    if (f[k] !== undefined) await setValue(s, sel, String(f[k]));
  }
}

export async function saveItem(s, settle = 700) {
  await clickSel(s, '#itemSaveBtn', { settle });
  return !(await evaluate(s, `document.getElementById('itemOverlay').classList.contains('open')`));
}

export async function addItemViaUi(s, f) {
  if (!(await openAddItem(s))) return false;
  await fillItem(s, f);
  return saveItem(s);
}

// The timeline folds items into collapsible stay/day groups; a nested row is
// unreachable until its group is open. Clicks re-render the board, so the
// toggle list is re-queried every pass (stale coordinates are the classic
// probe trap here).
export async function expandTimeline(s) {
  for (let i = 0; i < 15; i++) {
    const clicked = await clickSel(s, '.tl-toggle[aria-expanded="false"]', { settle: 350 });
    if (!clicked) return true;
  }
  return !(await evaluate(s, `!!document.querySelector('.tl-toggle[aria-expanded="false"]')`));
}

export async function switchView(s, view, settle = 900) {
  const id = { timeline: '#viewTimeline', days: '#viewDays', map: '#viewMap' }[view];
  await clickSel(s, id, { settle });
  return evaluate(s, `document.querySelector(${JSON.stringify(id)}).classList.contains('on')`);
}

export const escape = (s) => pressKey(s, 'Escape', 'Escape', 27);
export const ctrlKey = (s, key, keyCode) => pressKey(s, key, 'Key' + key.toUpperCase(), keyCode, 2);

// ---------------------------------------------------------------------------
// Share links: built with the app's own primitives (TripLogic is on window),
// so the payload is byte-compatible with what shareTrip() produces without
// touching the clipboard, which headless Chrome cannot grant.
export async function buildShareHash(s, tripObj) {
  const b64 = await evalAsync(s, `(async () => {
    const json = JSON.stringify({ version: 1, trip: TripLogic.slimTripForShare(${JSON.stringify(tripObj)}) });
    const cs = new CompressionStream('deflate');
    const w = cs.writable.getWriter(); w.write(new TextEncoder().encode(json)); w.close();
    const ab = await new Response(cs.readable).arrayBuffer();
    return TripLogic.bytesToBase64url(new Uint8Array(ab));
  })()`);
  return (b64 && !b64.__evalError) ? '#share=' + b64 : null;
}

export { closePage, goto, evaluate, evalAsync, waitForExpr, clickSel, setValue, pressKey, setViewport, screenshot, sleep };
