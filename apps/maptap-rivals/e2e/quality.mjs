// MapTap Rivals browser regression: the behaviours the 2026-08-22 audit found
// broken or unprotected, checked against a SEEDED app (rivals, games with and
// without geo data, a rival-only day, an orphaned game, a very long rival
// name) rather than the empty first-run state the shared suites see.
//
// Runs inside tests/browser/run.mjs:
//   npm run test:maptap-rivals:e2e        (equivalent to --only=maptap-rivals)
//
// What it pins, by audit finding:
//   #1/#2  dashboard strip and profile card exclude orphaned / rival-only rows
//   #3     datetime-shaped values (profile verifiedAt) render a date
//   #5     a malformed backup never replaces good state; app still renders
//   #6     12-hour and iPhone WhatsApp exports open the import modal
//   #12    zero serious/critical axe violations on RENDERED views, 1280 + 390
//   #13    keyboard: rival links, sortable headers, modal focus trap + return
//   #14    390px: no page-level horizontal scroll on any view, the tab strip
//          announces its overflow, the day tabs all fit, matrix cells do not
//          overlap, a 57-character rival name stays inside its cards
//   UX     delete-rival modal + Undo, inline name validation, paste date reset
//   stack  every dialog type covers the shared #header (z-index 10001): the
//          header strip is hit-tested, not screenshotted, so an ancestor
//          stacking context swallowing the raise would still fail
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  newPage, closePage, goto, evaluate, evalAsync, waitForExpr, clickSel, clickAt,
  setViewport, pressKey, sleep, interceptNetwork, cleanErrors,
} from '../../../tests/browser/cdp.mjs';

const APP = '/apps/maptap-rivals/index.html';
const AXE_PATH = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', 'tests', 'browser', 'vendor', 'axe.min.js');
const BLOCK = /firestore\.googleapis\.com|firebaseio\.com|identitytoolkit\.googleapis\.com|securetoken\.googleapis\.com|googletagmanager|google-analytics|cloudfunctions\.net/i;

// Daily puzzle stand-in (5 coordinates) so the predictions card renders rows.
const DAILY = 'const cities = [' + [
  [-12.0464, -77.0428, 'Lima'], [30.0444, 31.2357, 'Cairo'], [28.6139, 77.209, 'Delhi'], [21.3099, -157.8581, 'Honolulu'], [64.1466, -21.9426, 'Reykjavik'],
].map(([lat, lng, name]) => `{ name: "${name}", lat: ${lat}, lng: ${lng}, labelLat: ${lat + 1}, labelLng: ${lng + 1} }`).join(',') + '];';

function todayISO() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function addDays(iso, n) { const [y, m, d] = iso.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d) + n * 86400000); return t.toISOString().slice(0, 10); }

function fixture() {
  const T = todayISO();
  const geo = [{ lat: 48.8566, lng: 2.3522 }, { lat: 52.52, lng: 13.405 }, { lat: 35.6762, lng: 139.6503 }, { lat: 40.7128, lng: -74.006 }, { lat: -33.9249, lng: 18.4241 }];
  const geo2 = [{ lat: -33.8688, lng: 151.2093 }, { lat: -23.5505, lng: -46.6333 }, { lat: 40.4168, lng: -3.7038 }, { lat: 41.9028, lng: 12.4964 }, { lat: 51.5074, lng: -0.1278 }];
  const rivals = [
    { id: 'r-ari', name: 'Ari', color: '#f59e0b', icon: '🦊', maptapUsername: 'ari_mt', createdAt: 1 },
    { id: 'r-bex', name: 'Bex', color: '#3b82f6', icon: '🐧', maptapUsername: 'bexplays', createdAt: 1 },
    { id: 'r-cy', name: 'Cy', color: '#10b981', icon: '🐢', maptapUsername: '', createdAt: 1 },
    { id: 'r-long', name: 'Bartholomew Montgomery-Fitzgerald III of Westchestershire', color: '#a855f7', icon: '🐲', maptapUsername: 'longname', createdAt: 1 },
  ];
  let n = 0;
  const G = (o) => Object.assign({ id: 'g' + (++n), note: '', createdAt: n }, o);
  const games = [];
  // 12 synced days vs Ari (geo), alternating results, plus some vs Bex / long.
  for (let i = 14; i >= 3; i--) {
    const d = addDays(T, -i);
    const mine = [70 + (i % 3) * 10, 65, 80, 75, 60 + i];
    const theirs = i % 2 ? [60, 60, 60, 60, 60] : [90, 90, 90, 90, 90];
    games.push(G({ rivalId: 'r-ari', date: d, myScores: mine, theirScores: theirs, myScore: 0, theirScore: 0, cities: i % 2 ? geo : geo2, note: 'synced from MapTap' }));
    if (i % 3 === 0) games.push(G({ rivalId: 'r-bex', date: d, myScores: mine, theirScores: [70, 70, 70, 70, 70], cities: geo, note: 'synced from MapTap' }));
    if (i % 4 === 0) games.push(G({ rivalId: 'r-long', date: d, myScores: mine, theirScores: [75, 75, 75, 75, 75], cities: geo2, note: 'synced from MapTap' }));
  }
  for (const g of games) { g.myScore = g.myScores.reduce((a, v, i) => a + v * [1, 1, 2, 3, 3][i], 0); g.theirScore = g.theirScores.reduce((a, v, i) => a + v * [1, 1, 2, 3, 3][i], 0); }
  games.push(G({ rivalId: 'r-cy', date: addDays(T, -2), myScores: [80, 80, 80, 80, 80], theirScores: [80, 80, 80, 80, 80], myScore: 800, theirScore: 800 })); // tie, manual
  games.push(G({ rivalId: 'r-ari', date: addDays(T, -1), myScore: 500, theirScore: 650 }));                                     // legacy totals-only loss
  games.push(G({ rivalId: 'r-bex', date: addDays(T, -1), theirScores: [40, 40, 40, 40, 40], theirScore: 400, cities: geo, note: 'synced from MapTap' })); // rival-only
  games.push(G({ rivalId: 'r-gone', date: addDays(T, -1), myScores: [10, 10, 10, 10, 10], theirScores: [90, 90, 90, 90, 90], myScore: 100, theirScore: 900 })); // orphan
  games.push(G({ rivalId: 'r-ari', date: T, myScores: [77, 77, 77, 77, 77], theirScores: [70, 70, 70, 70, 70], myScore: 770, theirScore: 700, cities: geo, note: 'synced from MapTap' }));
  return { rivals, games };
}

const SEED_KV = (f) => ({
  maptapRivalsMe: JSON.stringify('Nikita'),
  maptapRivalsMyIcon: JSON.stringify('🧭'),
  maptapRivalsMyMapTap: JSON.stringify('nikita_mt'),
  maptapRivalsMyProfile: JSON.stringify({ userId: 'u1', nickname: 'Nikita_MT', joinDate: '2025-03-02T10:00:00.000Z', totalGames: 40, avgScore: 700, bestScore: 900, worstScore: 400, mostRecentDate: '2026-08-19', verifiedAt: '2026-08-20T15:30:00.000Z' }),
  maptapRivalsRivals: JSON.stringify(f.rivals),
  maptapRivalsGames: JSON.stringify(f.games),
});

export async function run({ base, cdpPort }) {
  const R = [];
  const t = (name, pass, detail = '') => R.push({ name, pass: !!pass, detail: String(detail).slice(0, 220) });
  const axeSource = await readFile(AXE_PATH, 'utf8');
  const txt = (s, sel) => evaluate(s, `((document.querySelector(${JSON.stringify(sel)})||{}).textContent||'').replace(/\\s+/g,' ').trim()`);
  const OVERFLOW = `(()=>{const de=document.documentElement; return {scrollW:de.scrollWidth, clientW:de.clientWidth}})()`;

  // Same-document navigation, the way a user's click or Back button does it.
  // NOT goto(): Page.navigate to a URL that differs only in the fragment is a
  // same-document navigation, so Page.loadEventFired never arrives and the
  // driver waits out its full 20s guard EVERY time. With ~50 view changes in
  // this suite that is ~17 minutes of dead wait, and a session that long
  // starts timing out its own Runtime.evaluate calls. Setting location.hash
  // in-page also exercises the real hashchange route, which is the path the
  // dialog-closing fix hangs off.
  async function hashTo(page, hash, settle = 900) {
    page.errors.length = 0;
    await evaluate(page, `(()=>{ location.hash = ${JSON.stringify(hash)}; return 1 })()`);
    await sleep(settle);
  }

  async function open() {
    const s = await newPage(cdpPort);
    await interceptNetwork(s, (url) => {
      if (BLOCK.test(url)) return 'fail';
      if (/this_day_in_history/.test(url)) return { status: 200, contentType: 'application/javascript', body: DAILY };
      if (/maptap\.gg/.test(url)) return 'fail';
      return null;
    });
    return s;
  }
  async function seed(s, hash = '#dashboard', extra = {}) {
    await goto(s, `${base}/apps/maptap-rivals/css/styles.css`, { settle: 150 });
    const kv = { ...SEED_KV(fixture()), ...extra };
    await evaluate(s, `(()=>{ for (const k of Object.keys(localStorage)) localStorage.removeItem(k); const kv=${JSON.stringify(kv)}; for (const [k,v] of Object.entries(kv)) localStorage.setItem(k, v); return 1 })()`);
    await goto(s, `${base}${APP}${hash}`, { settle: 1500 });
  }
  // Injecting ~500KB of axe and scanning a seeded, data-heavy view is the
  // slowest thing this suite does. On a loaded machine (several Chromium
  // instances from other checkouts) a single scan can exceed the driver's 45s
  // send timeout. Contain that to the one check: a throw here used to unwind
  // to the outer catch and silently drop every remaining check in the suite,
  // turning one slow scan into a 19-of-71 run. The scan still reports FAIL,
  // so nothing is hidden - the rest of the suite just gets to run.
  async function axe(s, label) {
    const name = `a11y ${label}: no serious/critical axe violations on rendered content`;
    try {
      if (!(await evaluate(s, "typeof window.axe === 'object' && typeof window.axe.run === 'function'"))) {
        await s.send('Runtime.evaluate', { expression: axeSource, returnByValue: false });
      }
      const v = await evalAsync(s, `window.axe.run(document.querySelector('main.page') || document, { runOnly: { type: 'tag', values: ['wcag2a','wcag2aa','wcag21aa'] }, resultTypes: ['violations'] }).then(r => r.violations.filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => v.id + ' [' + v.impact + '] x' + v.nodes.length + ' @ ' + (v.nodes[0].target||[]).join(' ')))`);
      t(name, Array.isArray(v) && v.length === 0, Array.isArray(v) ? v.join(' | ') : JSON.stringify(v));
    } catch (e) {
      t(name, false, `scan did not complete: ${String(e && e.message || e)}`);
    }
  }

  let s = null;
  let step = 'startup';
  const mark = (label) => { step = label; };
  try {
    s = await open();
    await setViewport(s, 1280, 900);
    mark('seed');
    await seed(s);
    t('seeded dashboard renders rival cards and prediction rows', await waitForExpr(s, "document.querySelectorAll('.rival-card').length===4 && document.querySelectorAll('#todays-card .pred-row:not(.pred-row-head)').length>=4"));

    // ---- #1 / #2 / #3 data honesty ----
    const strip = await txt(s, '#dash-summary');
    t('#1 dashboard strip excludes the orphaned game (banner and strip agree)', /over 22 games/.test(strip) && !/over 23 games/.test(strip), strip);
    const profile = await txt(s, '#profile-card');
    t('#2 profile card counts eligible H2H games only (22, not 24)', /Tracked H2H games22/.test(profile), profile);
    t('#3 "Last verified" and "joined" render dates for datetime values', /Last verified Aug 20, 2026/.test(profile) && /joined Mar 2, 2025/.test(profile), profile);
    t('profile card collapses to one line once verified (expand control present)', (await evaluate(s, "document.getElementById('profile-card').classList.contains('is-compact') && !!document.querySelector('#profile-card .card-toggle')")));
    await clickSel(s, '#profile-card .card-toggle', { settle: 300 });
    t('profile card expands on demand and shows its stats', !(await evaluate(s, "document.getElementById('profile-card').classList.contains('is-compact')")) && (await evaluate(s, "document.querySelectorAll('#profile-card .profile-info-cell').length")) === 4);

    // ---- #12 axe on rendered views (1280) ----
    await evaluate(s, "(()=>{document.querySelector('details.paste-collapse').open = true; return 1})()");
    await clickSel(s, '.pred-label-toggle', { nth: 0, settle: 300 });
    mark('axe dashboard @1280');
    await axe(s, 'dashboard @1280 (paste open, finishes expanded)');
    for (const v of ['rival/r-ari', 'leaderboard', 'matrix', 'records', 'history']) {
      mark(`axe ${v} @1280`);
      await hashTo(s, `#${v}`, 1200);
      await axe(s, `${v} @1280`);
    }
    await hashTo(s, '#dashboard', 1000);
    await clickSel(s, '#add-rival-btn', { settle: 300 });
    await axe(s, 'rival modal');
    await pressKey(s, 'Escape', 'Escape', 27); await sleep(200);

    // ---- #13 keyboard ----
    t('rival cards expose a real link to the rival page', (await evaluate(s, "document.querySelectorAll('.rival-card .rival-card-link[href^=\"#rival/\"]').length")) === 4);
    await evaluate(s, "document.querySelector('.rival-card-link').focus()");
    await pressKey(s, 'Enter', 'Enter', 13); await sleep(600);
    t('Enter on a rival card link opens that rival page', (await evaluate(s, 'location.hash')) === '#rival/r-ari' && (await txt(s, '#rival-header h2')) === 'Ari', await evaluate(s, 'location.hash'));
    await hashTo(s, '#leaderboard', 1000);
    t('leaderboard rows carry a link and headers are real buttons with aria-sort on the th', (await evaluate(s, "document.querySelectorAll('.lb-rival-link').length")) >= 3 && (await evaluate(s, "document.querySelectorAll('th[aria-sort] > .lb-sort-btn').length")) === 9);
    await evaluate(s, "document.querySelector('#lb-th-games .lb-sort-btn').focus()");
    await pressKey(s, 'Enter', 'Enter', 13, 0, '\r'); await sleep(300);
    t('Enter on a focused sort button sorts (aria-sort=descending)', (await evaluate(s, "document.getElementById('lb-th-games').getAttribute('aria-sort')")) === 'descending');
    const focusStyles = await evaluate(s, `(()=>{const out={}; for (const sel of ['#my-name','#my-icon-btn','.view-tab','.lb-sort-btn']) { const e=document.querySelector(sel); e.focus(); const cs=getComputedStyle(e); out[sel]=cs.outlineStyle+' '+cs.outlineWidth; } return out})()`);
    t('settings-strip controls and tabs show a visible focus outline', Object.values(focusStyles).every(v => /solid|auto/.test(v) && !/0px/.test(v)), JSON.stringify(focusStyles));

    // ---- modal focus trap + return ----
    await hashTo(s, '#dashboard', 1000);
    await clickSel(s, '#add-rival-btn', { settle: 300 });
    t('rival modal opens with focus on the name field', (await evaluate(s, 'document.activeElement.id')) === 'rival-name');
    await evaluate(s, "document.getElementById('rival-save-btn').focus()");
    await pressKey(s, 'Tab', 'Tab', 9); await sleep(100);
    t('Tab from the last control stays inside the dialog', await evaluate(s, "document.getElementById('rival-modal').contains(document.activeElement)"), await evaluate(s, 'document.activeElement.id||document.activeElement.className'));
    await clickSel(s, '#rival-save-btn', { settle: 200 });
    t('saving an empty name shows inline validation', (await txt(s, '#rival-name-error')) === 'Enter a name for this rival.' && (await evaluate(s, "document.getElementById('rival-name').getAttribute('aria-invalid')")) === 'true');
    await evaluate(s, "(()=>{const i=document.getElementById('rival-name'); i.value='ari'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1})()");
    t('typing an existing name shows the duplicate hint', /already have a rival named "Ari"/.test(await txt(s, '#rival-name-hint')));
    await pressKey(s, 'Escape', 'Escape', 27); await sleep(250);
    t('Escape closes the modal and returns focus to "+ Add rival"', (await evaluate(s, "document.getElementById('rival-modal').hidden")) && (await evaluate(s, 'document.activeElement.id')) === 'add-rival-btn', await evaluate(s, 'document.activeElement.id'));

    // ---- delete rival: styled modal + undo ----
    await clickSel(s, '.rival-card[data-rival-id="r-cy"] .rival-card-edit', { settle: 300 });
    await clickSel(s, '#rival-delete-btn', { settle: 300 });
    t('delete rival uses the styled confirmation (no native confirm)', !(await evaluate(s, "document.getElementById('delete-rival-modal').hidden")) && /Delete Cy and all 1 game logged/.test(await txt(s, '#delete-rival-body')), await txt(s, '#delete-rival-body'));
    await clickSel(s, '#delete-rival-confirm', { settle: 600 });
    t('rival deleted, Undo toast offered', (await evaluate(s, "JSON.parse(localStorage.getItem('maptapRivalsRivals')).length")) === 3 && !!(await evaluate(s, "document.querySelector('.share-toast-action')")));
    const undoBox = await evaluate(s, "(()=>{const b=document.querySelector('.share-toast-action'); const r=b.getBoundingClientRect(); const hit=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2); return {x:r.left+r.width/2, y:r.top+r.height/2, onTop: hit===b}})()");
    t('Undo button is on top of the page (hit-testable)', undoBox.onTop, JSON.stringify(undoBox));
    await clickAt(s, undoBox.x, undoBox.y); await sleep(500);
    t('Undo restores the rival and their game', (await evaluate(s, "JSON.parse(localStorage.getItem('maptapRivalsRivals')).length")) === 4 && (await evaluate(s, "JSON.parse(localStorage.getItem('maptapRivalsGames')).some(g=>g.rivalId==='r-cy')")));

    // ---- paste date resets after a save ----
    await evaluate(s, "document.querySelectorAll('.share-toast').forEach(t => t.remove())");
    // Chromium restores a <details> open state across same-document navigations,
    // so set it rather than toggling it.
    await evaluate(s, "(()=>{document.querySelector('details.paste-collapse').open = true; return 1})()"); await sleep(200);
    await evaluate(s, `(()=>{const m=document.getElementById('paste-mine-input'); m.value='Aug 1\\n50 50 50 50 50'; m.dispatchEvent(new Event('input',{bubbles:true})); const r=document.querySelector('.paste-rival-row[data-rival-id="r-cy"] textarea'); r.value='Aug 1\\n40 40 40 40 40'; r.dispatchEvent(new Event('input',{bubbles:true})); return 1})()`);
    t('paste date hint names a non-today date', /Logging for .*Aug 1, /.test(await txt(s, '#paste-date-hint')), await txt(s, '#paste-date-hint'));
    const saveHit = await evaluate(s, "(()=>{const b=document.getElementById('paste-save-all'); b.scrollIntoView({block:'center'}); const r=b.getBoundingClientRect(); const h=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2); return {disabled:b.disabled, hit: h && (h.id||h.className||h.tagName), onTop: h===b || (h && b.contains(h))}})()");
    t('paste save button is enabled and on top (hit-testable)', !saveHit.disabled && saveHit.onTop, JSON.stringify(saveHit));
    await clickSel(s, '#paste-save-all', { settle: 600 });
    t('paste date resets to today after saving and the summary names the saved day', (await evaluate(s, "document.getElementById('paste-date').value")) === todayISO() && /for Aug 1 /.test(await txt(s, '#paste-summary')), await txt(s, '#paste-summary'));

    // ---- #5 malformed import leaves state intact ----
    // Under the repo (gitignored .screenshots/): snap-packaged Chromium cannot
    // read files from /tmp, so a tmpdir() path would make the file input a no-op.
    const dir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', '.screenshots', 'maptap-e2e-tmp');
    await mkdir(dir, { recursive: true });
    const bad = path.join(dir, 'malformed.json');
    await writeFile(bad, JSON.stringify({ rivals: [{ id: 'm1', name: 'Mal' }, null, 'junk'], games: [{ id: 'q', rivalId: 'm1', myScores: [1, 2, 3, 4, 5], theirScores: [1, 2, 3, 4, 5] }, null, 42] }));
    const notJson = path.join(dir, 'bad.json');
    await writeFile(notJson, 'not json {');
    const dialogs = [];
    s.on((m, p) => { if (m === 'Page.javascriptDialogOpening') { dialogs.push(p.type + ': ' + p.message); s.send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {}); } });
    const gamesBefore = await evaluate(s, "localStorage.getItem('maptapRivalsGames')");
    async function setFile(sel, file) {
      const doc = await s.send('DOM.getDocument', { depth: 1 });
      const { nodeId } = await s.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: sel });
      await s.send('DOM.setFileInputFiles', { nodeId, files: [file] });
      await sleep(700);
    }
    await setFile('#import-file', notJson);
    t('import: invalid JSON is refused with a clear message and nothing changes', dialogs.some(d => /not valid JSON. Nothing was changed/.test(d)) && (await evaluate(s, "localStorage.getItem('maptapRivalsGames')")) === gamesBefore, dialogs.join(' | '));
    await setFile('#import-file', bad);
    t('import: malformed rows are counted in the confirm; declining keeps current data', dialogs.some(d => /2 rivals and 3 games in the file could not be read/.test(d)) && (await evaluate(s, "localStorage.getItem('maptapRivalsGames')")) === gamesBefore, dialogs.join(' | '));
    s.errors.length = 0;
    for (const v of ['leaderboard', 'matrix', 'records', 'history']) await clickSel(s, `.view-tab[data-view="${v}"]`, { settle: 300 });
    t('every view still renders after the refused imports (no JS errors)', cleanErrors(s).length === 0, cleanErrors(s).join(' | '));

    // ---- #6 WhatsApp formats ----
    const wa12 = path.join(dir, 'wa12.txt');
    await writeFile(wa12, '8/10/26, 9:05 PM - Nikita: MapTap\nAug 10\n95 89 91 9 64\nFinal score: 585\n8/10/26, 9:07 PM - Ari: MapTap Aug 10\n70 80 60 50 40');
    const waIos = path.join(dir, 'wa-ios.txt');
    await writeFile(waIos, '[10/08/2026, 21:05:12] Nikita: MapTap\nAug 10\n95 89 91 9 64\n[10/08/2026, 21:07:00] Ari: MapTap Aug 10\n70 80 60 50 40');
    await hashTo(s, '#dashboard', 1000);
    await setFile('#wa-import-file', wa12);
    t('WhatsApp: 12-hour Android export opens the importer with the detected format', !(await evaluate(s, "document.getElementById('wa-modal').hidden")) && /2 messages/.test(await txt(s, '#wa-overview')) && /12-hour clock/.test(await txt(s, '#wa-format')), await txt(s, '#wa-overview') + ' ' + await txt(s, '#wa-format'));
    await pressKey(s, 'Escape', 'Escape', 27); await sleep(200);
    await setFile('#wa-import-file', waIos);
    t('WhatsApp: iPhone bracketed export with day-first dates is read as day/month/year', !(await evaluate(s, "document.getElementById('wa-modal').hidden")) && /iPhone export/.test(await txt(s, '#wa-format')) && (await evaluate(s, "document.getElementById('wa-date-order').value")) === 'DMY', await txt(s, '#wa-format'));
    await pressKey(s, 'Escape', 'Escape', 27); await sleep(200);

    // ---- modal layer vs the shared site header (fixed 2026-08-23) ----
    // The shared chrome pins #header at z-index 10001; .modal used to sit at
    // 100, so the header stayed lit above the backdrop and a click at the top
    // of the screen hit the site logo and navigated away with the dialog open.
    // Asserted by hit-testing, not by screenshot: computed z-index alone would
    // not catch an ancestor stacking context swallowing the raise.
    const STACK = (modalId) => `(()=>{
      const modal = document.getElementById(${JSON.stringify(modalId)});
      const header = document.getElementById('header');
      if (!header) return { error: 'no shared #header on the page' };
      if (!modal || modal.hidden) return { error: 'modal ' + ${JSON.stringify(modalId)} + ' is not open' };
      const hr = header.getBoundingClientRect();
      const inside = (node) => !!node && (node === modal || modal.contains(node));
      // A point over the header strip, and the logo's own centre.
      const hx = Math.min(Math.max(hr.left + 6, 2), innerWidth - 2);
      const hy = Math.min(Math.max(hr.top + hr.height / 2, 2), innerHeight - 2);
      const logo = header.querySelector('a.logo');
      const lr = logo ? logo.getBoundingClientRect() : hr;
      const lx = Math.min(Math.max(lr.left + lr.width / 2, 2), innerWidth - 2);
      const ly = Math.min(Math.max(lr.top + lr.height / 2, 2), innerHeight - 2);
      const atHeader = document.elementFromPoint(hx, hy);
      const atLogo = document.elementFromPoint(lx, ly);
      // Panel must win over its own backdrop.
      const panel = modal.querySelector('.modal-panel');
      const pr = panel.getBoundingClientRect();
      const atPanel = document.elementFromPoint(pr.left + pr.width / 2, pr.top + 8);
      return {
        headerZ: parseInt(getComputedStyle(header).zIndex, 10),
        modalZ: parseInt(getComputedStyle(modal).zIndex, 10),
        headerCovered: inside(atHeader),
        logoCovered: inside(atLogo),
        logoReachable: !!(atLogo && atLogo.closest && atLogo.closest('#header')),
        panelOverBackdrop: !!(atPanel && panel.contains(atPanel)),
        atHeader: atHeader ? (atHeader.id || atHeader.className || atHeader.tagName) : null,
        logoPoint: [Math.round(lx), Math.round(ly)],
      };
    })()`;
    async function stackCheck(label, modalId) {
      const r = await evaluate(s, STACK(modalId));
      t(`stacking: ${label} covers the shared site header`,
        !r.error && r.modalZ > r.headerZ && r.headerCovered && r.logoCovered && !r.logoReachable && r.panelOverBackdrop,
        JSON.stringify(r));
      return r;
    }

    await setViewport(s, 1280, 900);
    await hashTo(s, '#dashboard', 1200);
    t('shared site header is present in this harness (the stacking checks are not vacuous)',
      (await evaluate(s, "!!document.getElementById('header') && !!document.querySelector('#header a.logo')")));

    mark('stacking rival-modal');
    await clickSel(s, '#add-rival-btn', { settle: 350 });
    const rivalStack = await stackCheck('add-rival dialog', 'rival-modal');
    // A REAL coordinate click where the logo sits must not navigate away.
    const hashBefore = await evaluate(s, 'location.hash');
    await clickAt(s, rivalStack.logoPoint[0], rivalStack.logoPoint[1]); await sleep(500);
    t('stacking: clicking over the logo with a dialog open does not leave the app',
      (await evaluate(s, 'location.pathname')).endsWith('/apps/maptap-rivals/index.html') && (await evaluate(s, 'location.hash')) === hashBefore,
      await evaluate(s, 'location.pathname + location.hash'));
    t('stacking: that click landed on the backdrop and closed the dialog (normal backdrop behaviour)',
      await evaluate(s, "document.getElementById('rival-modal').hidden"));

    mark('stacking delete-rival-modal');
    await clickSel(s, '.rival-card[data-rival-id="r-cy"] .rival-card-edit', { settle: 350 });
    await clickSel(s, '#rival-delete-btn', { settle: 350 });
    await stackCheck('delete-rival confirmation', 'delete-rival-modal');
    t('stacking: the confirmation sits above the edit dialog it was opened from',
      await evaluate(s, "(()=>{const a=document.getElementById('delete-rival-modal'), b=document.getElementById('rival-modal'); if (b.hidden) return true; return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING})()"));
    await pressKey(s, 'Escape', 'Escape', 27); await sleep(250);
    t('stacking: Escape closes only the top dialog, the edit dialog stays open',
      (await evaluate(s, "document.getElementById('delete-rival-modal').hidden")) && !(await evaluate(s, "document.getElementById('rival-modal').hidden")));
    await pressKey(s, 'Escape', 'Escape', 27); await sleep(250);
    t('stacking: a second Escape closes the edit dialog too', await evaluate(s, "document.getElementById('rival-modal').hidden"));

    mark('stacking clear-games-modal');
    await clickSel(s, '#clear-games-btn', { settle: 350 });
    await stackCheck('clear-games confirmation', 'clear-games-modal');
    await pressKey(s, 'Escape', 'Escape', 27); await sleep(250);

    mark('stacking wa-modal');
    await setFile('#wa-import-file', wa12);
    await stackCheck('WhatsApp importer', 'wa-modal');
    await pressKey(s, 'Escape', 'Escape', 27); await sleep(250);

    mark('stacking delete-game-modal');
    await hashTo(s, '#history', 1000);
    await clickSel(s, '#history-table button[aria-label="Delete game"]', { nth: 0, settle: 350 });
    await stackCheck('delete-game confirmation', 'delete-game-modal');
    await pressKey(s, 'Escape', 'Escape', 27); await sleep(250);

    // The toast is the app's last word on an action: it has to clear the
    // header and an open dialog, and stay under the shared offline banner.
    const layers = await evaluate(s, `(()=>{
      const probe = document.createElement('div');
      probe.className = 'share-toast';
      document.body.appendChild(probe);
      const z = getComputedStyle(probe).zIndex;
      probe.remove();
      const modal = document.getElementById('rival-modal');
      return { toast: parseInt(z, 10), modal: parseInt(getComputedStyle(modal).zIndex, 10), header: parseInt(getComputedStyle(document.getElementById('header')).zIndex, 10) };
    })()`);
    t('stacking: toast > dialog > header, and the toast stays below the shared offline banner (10100)',
      layers.toast > layers.modal && layers.modal > layers.header && layers.toast < 10100, JSON.stringify(layers));

    // A route change must close open dialogs: the view under them is swapped,
    // so an editor left open would show one rival's data over another's page
    // and Save would write to the rival the user is no longer looking at.
    mark('stacking route change closes dialogs');
    await hashTo(s, '#rival/r-bex', 1000);
    await clickSel(s, '.rival-header-actions .btn-ghost', { nth: 1, settle: 350 });
    t('editing a rival from its own page opens the dialog with that rival loaded',
      !(await evaluate(s, "document.getElementById('rival-modal').hidden")) && (await evaluate(s, "document.getElementById('rival-name').value")) === 'Bex',
      await evaluate(s, "document.getElementById('rival-name').value"));
    await hashTo(s, '#rival/r-ari', 900);
    t('navigating to another rival closes the open editor instead of leaving it over the new page',
      await evaluate(s, "document.getElementById('rival-modal').hidden"));
    t('after that navigation the page beneath is reachable again (no orphaned backdrop)',
      await evaluate(s, "(()=>{const b=document.getElementById('add-rival-btn')||document.querySelector('.rival-header-actions .btn-ghost'); const r=b.getBoundingClientRect(); const hit=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2); return !!hit && !hit.closest('.modal')})()"));

    mark('stacking @390');
    await setViewport(s, 390, 844, true);
    await hashTo(s, '#dashboard', 1200);
    await clickSel(s, '#add-rival-btn', { settle: 350 });
    await stackCheck('add-rival dialog @390', 'rival-modal');
    t('390px: an open dialog still traps Tab inside the panel',
      await evaluate(s, "(()=>{const m=document.getElementById('rival-modal'); return m.contains(document.activeElement)})()"));
    await pressKey(s, 'Escape', 'Escape', 27); await sleep(250);
    t('390px: Escape closes the dialog and focus returns to the trigger',
      (await evaluate(s, "document.getElementById('rival-modal').hidden")) && (await evaluate(s, 'document.activeElement.id')) === 'add-rival-btn',
      await evaluate(s, 'document.activeElement.id'));

    // ---- #14 responsive containment ----
    // Every breakpoint the layout actually switches at, not just the two ends:
    // 480 (type floor), 768 (touch-target rules), 1024, and 1159/1160 - the
    // pair that bracket the continent band's three-tier grid, where the
    // 2026-08-22 audit found long names pushing the page sideways.
    for (const [w, h, mobile] of [[390, 844, true], [480, 900, true], [768, 1024, true], [1024, 900, false], [1159, 900, false], [1160, 900, false], [1280, 900, false]]) {
      await setViewport(s, w, h, mobile);
      for (const v of ['dashboard', 'rival/r-long', 'leaderboard', 'matrix', 'records', 'history']) {
        mark(`overflow ${w}px ${v}`);
        await hashTo(s, `#${v}`, 900);
        if (v === 'dashboard') { await clickSel(s, '.pred-label-toggle', { nth: 0, settle: 200 }); }
        const ov = await evaluate(s, OVERFLOW);
        t(`${w}px ${v}: no page-level horizontal scroll`, ov.scrollW <= ov.clientW + 1, JSON.stringify(ov));
      }
    }
    await setViewport(s, 390, 844, true);
    await hashTo(s, '#dashboard', 1200);
    const tabs = await evaluate(s, "(()=>{const n=document.querySelector('.view-tabs'); return {scroll:n.dataset.scroll, mask: getComputedStyle(n).maskImage !== 'none' || getComputedStyle(n).webkitMaskImage !== 'none', scrollable: n.scrollWidth > n.clientWidth}})()");
    t('390px: the tab strip is scrollable and fades its overflowing edge', tabs.scrollable && tabs.scroll === 'start' && tabs.mask, JSON.stringify(tabs));
    const days = await evaluate(s, "(()=>{const n=document.querySelector('.pred-day-tabs'); const r=n.getBoundingClientRect(); return {tabs:n.children.length, fit: n.scrollWidth <= n.clientWidth + 1, minFont: Math.min(...[...n.querySelectorAll('.pred-day-tab-name')].map(e=>parseFloat(getComputedStyle(e).fontSize)))}})()");
    t('390px: all 7 prediction day tabs fit without scrolling, text >= 10px', days.tabs === 7 && days.fit && days.minFont >= 10, JSON.stringify(days));
    const smallest = await evaluate(s, "(()=>{let min=99; for (const e of document.querySelectorAll('#todays-card *')) { if (!e.textContent.trim() || e.children.length) continue; min=Math.min(min, parseFloat(getComputedStyle(e).fontSize)); } return min})()");
    t('390px: no prediction-card text under 10px', smallest >= 10, String(smallest));
    mark('axe dashboard @390');
    await axe(s, 'dashboard @390');
    await hashTo(s, '#matrix', 1000);
    const mx = await evaluate(s, "(()=>{const cells=[...document.querySelectorAll('.matrix-cell')]; const over=cells.filter(c=>{const r=c.querySelector('.matrix-record'); return r && r.scrollWidth>c.clientWidth+1}).length; const heads=[...document.querySelectorAll('.matrix-row-head')].filter(h=>h.scrollWidth>h.clientWidth+1).length; const wrap=document.getElementById('matrix-wrap'); const chip=[...document.querySelectorAll('.matrix-chip')].find(c=>/Bartholomew/.test(c.textContent)); return {over, heads, wrapScrolls: wrap.scrollWidth>wrap.clientWidth, chipInside: chip.getBoundingClientRect().right <= document.querySelector('.matrix-controls').getBoundingClientRect().right + 1}})()");
    t('390px matrix: scrolls inside its wrap, no cell or row-head overflow, long chip contained', mx.over === 0 && mx.heads === 0 && mx.wrapScrolls && mx.chipInside, JSON.stringify(mx));
    mark('axe matrix @390');
    await axe(s, 'matrix @390');
    await hashTo(s, '#rival/r-long', 1000);
    const longName = await evaluate(s, "(()=>{const h=document.querySelector('#rival-header h2'); const r=h.getBoundingClientRect(); return {right: Math.round(r.right), vw: innerWidth, overflow: h.scrollWidth > h.clientWidth + 1}})()");
    t('390px: a 57-character rival name wraps inside the header', longName.right <= longName.vw && !longName.overflow, JSON.stringify(longName));
    await setViewport(s, 1280, 900);
    await hashTo(s, '#dashboard', 1000);
    const longCard = await evaluate(s, "(()=>{const c=[...document.querySelectorAll('.dash-summary-card')].find(c=>/Bartholomew/.test(c.textContent)); if(!c) return {none:true}; const v=c.querySelector('.value'); return {overflow: v.scrollWidth > v.clientWidth + 1, cardRight: Math.round(c.getBoundingClientRect().right), stripRight: Math.round(document.getElementById('dash-summary').getBoundingClientRect().right)}})()");
    t('1280px: a long name in a summary card wraps instead of overflowing', longCard.none || (!longCard.overflow && longCard.cardRight <= longCard.stripRight + 1), JSON.stringify(longCard));

    // ---- a stale rival id in the persisted matrix selection is harmless ----
    // Deleting a rival prunes it from state.matrixSelection, but only on the
    // device that did the delete: the rival list and the selection sync under
    // separate keys, so another device can boot with a selection naming a
    // rival that is gone. matrixRivals() filters the selection THROUGH
    // state.rivals rather than trusting it, which is the same rule that keeps
    // orphaned games out of the aggregates. Pinned because the alternative
    // (auto-pruning the selection on load) would let one device's delete
    // quietly rewrite another's saved view.
    mark('stale matrix selection');
    await seed(s, '#matrix', { maptapRivalsMatrixSelection: JSON.stringify(['r-ari', 'r-gone-forever', 'r-bex']) });
    await waitForExpr(s, "!!document.querySelector('.matrix-table')");
    const mxSel = await evaluate(s, "(()=>{const heads=[...document.querySelectorAll('.matrix-row-head .matrix-head-name')].map(e=>e.textContent.trim()); return {heads, stored: localStorage.getItem('maptapRivalsMatrixSelection')}})()");
    t('matrix ignores a selected rival that no longer exists and renders the real ones',
      mxSel.heads.length > 0 && !mxSel.heads.some(h => /gone/i.test(h)), JSON.stringify(mxSel.heads));
    t('the stale id is left in storage rather than silently rewritten',
      /r-gone-forever/.test(String(mxSel.stored)), String(mxSel.stored));
    t('no first-party JS errors rendering the matrix from a stale selection',
      cleanErrors(s).length === 0, cleanErrors(s).join(' | '));

    // ---- Path to parity reports FUTURE wins, at both widths ----
    // The reported case: 26W/128L/1T used to read "Need 51 flipped results to
    // reach parity", which is ceil(102/2) - how many PAST losses would have to
    // be rewritten - and reads as "win 51 more", which is false.
    mark('parity card');
    const parityGames = [];
    let pg = 0;
    const PDAY = (i) => addDays(todayISO(), -(i + 2));
    for (let i = 0; i < 26; i++) parityGames.push({ id: 'pw' + (++pg), rivalId: 'r-ari', date: PDAY(pg), myScores: [90, 90, 90, 90, 90], theirScores: [10, 10, 10, 10, 10], myScore: 900, theirScore: 100, note: '', createdAt: pg });
    for (let i = 0; i < 128; i++) parityGames.push({ id: 'pl' + (++pg), rivalId: 'r-ari', date: PDAY(pg), myScores: [10, 10, 10, 10, 10], theirScores: [90, 90, 90, 90, 90], myScore: 100, theirScore: 900, note: '', createdAt: pg });
    parityGames.push({ id: 'pt' + (++pg), rivalId: 'r-ari', date: PDAY(pg), myScores: [50, 50, 50, 50, 50], theirScores: [50, 50, 50, 50, 50], myScore: 500, theirScore: 500, note: '', createdAt: pg });
    const parityCard = `(()=>{const c=[...document.querySelectorAll('#rival-stat-cards .stat-card')].find(c=>/Path to parity|Record balance/.test(c.querySelector('.label').textContent));
      if (!c) return {none:true};
      const r=c.getBoundingClientRect(), v=c.querySelector('.value'), sb=c.querySelector('.sub');
      return { label:c.querySelector('.label').textContent.trim(), value:v.textContent.trim(), sub:sb?sb.textContent.trim():'',
               cls:c.className, overflow: v.scrollWidth > v.clientWidth + 1 || (sb && sb.scrollWidth > sb.clientWidth + 1),
               right: Math.round(r.right), vw: innerWidth };})()`;
    for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
      await setViewport(s, w, h, mobile);
      await seed(s, '#rival/r-ari', { maptapRivalsGames: JSON.stringify(parityGames) });
      await waitForExpr(s, "document.querySelectorAll('#rival-stat-cards .stat-card').length > 0");
      const pc = await evaluate(s, parityCard);
      t(`${w}px parity: 26W/128L/1T asks for the 102 FUTURE wins, never the halved 51`,
        !pc.none && pc.value === 'Need 102 more wins to even the record' && !/flipped|51/.test(pc.value), JSON.stringify(pc));
      t(`${w}px parity: the sub-line states the record it was computed from`,
        !pc.none && pc.sub === 'Current record: 26W · 128L · 1T', pc.sub);
      t(`${w}px parity: the card fits its column without clipping or widening the page`,
        !pc.none && !pc.overflow && pc.right <= pc.vw, JSON.stringify(pc));
    }
    // Even and ahead render sensibly instead of a negative or a stale ask.
    const evenGames = parityGames.filter(g => /^pt/.test(g.id) || Number(g.id.slice(2)) <= 26 || (/^pl/.test(g.id) && Number(g.id.slice(2)) <= 52));
    await setViewport(s, 1280, 900);
    await seed(s, '#rival/r-ari', { maptapRivalsGames: JSON.stringify(evenGames) });
    await waitForExpr(s, "document.querySelectorAll('#rival-stat-cards .stat-card').length > 0");
    const evenCard = await evaluate(s, parityCard);
    t('parity: an even record says so instead of asking for wins',
      evenCard.label === 'Record balance' && evenCard.value === 'The record is even' && !/is-bad/.test(evenCard.cls), JSON.stringify(evenCard));
    await seed(s, '#rival/r-ari', { maptapRivalsGames: JSON.stringify(parityGames.filter(g => /^pw/.test(g.id) || (/^pl/.test(g.id) && Number(g.id.slice(2)) <= 36))) });
    await waitForExpr(s, "document.querySelectorAll('#rival-stat-cards .stat-card').length > 0");
    const aheadCard = await evaluate(s, parityCard);
    t('parity: ahead reports the lead, with no negative number anywhere',
      aheadCard.label === 'Record balance' && /^Ahead by \d+ wins?$/.test(aheadCard.value) && !/-\d/.test(aheadCard.value + aheadCard.sub), JSON.stringify(aheadCard));
    await setViewport(s, 1280, 900);

    // ---- #4 local calendar days, in a RENDERED page under UTC+12 ----
    // tests/stats.test.js proves the helpers across four zones in child
    // processes; this proves the views built on them. The zone comes from
    // CDP's Emulation.setTimezoneOverride, not the TZ env var: snap-confined
    // Chromium ignores TZ, which is why the audit's Berlin probe silently ran
    // in the host zone and only its own precondition check noticed.
    mark('UTC+12 rendered day');
    const tzPage = await open();
    try {
      await setViewport(tzPage, 1280, 900);
      await tzPage.send('Emulation.setTimezoneOverride', { timezoneId: 'Pacific/Auckland' });
      await goto(tzPage, `${base}/apps/maptap-rivals/css/styles.css`, { settle: 150 });
      const zone = await evaluate(tzPage, "Intl.DateTimeFormat().resolvedOptions().timeZone");
      // The browser's OWN local day, which is what every view must agree with.
      const bToday = await evaluate(tzPage, "(()=>{const d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')})()");
      const legacy = await evaluate(tzPage, "new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).toISOString().slice(0,10)");
      t('UTC+12: the browser really is in Pacific/Auckland and the legacy UTC expression drifts off today',
        zone === 'Pacific/Auckland' && legacy !== bToday, `${zone}: legacy ${legacy} vs local ${bToday}`);
      const f = fixture();
      f.games.push({ id: 'tz-today', rivalId: 'r-ari', date: bToday, myScores: [70, 70, 70, 70, 70], theirScores: [60, 60, 60, 60, 60], myScore: 700, theirScore: 600, note: '', createdAt: 9e12 });
      const kv = { ...SEED_KV(f) };
      await evaluate(tzPage, `(()=>{ for (const k of Object.keys(localStorage)) localStorage.removeItem(k); const kv=${JSON.stringify(kv)}; for (const [k,v] of Object.entries(kv)) localStorage.setItem(k, v); return 1 })()`);
      await goto(tzPage, `${base}${APP}#dashboard`, { settle: 1800 });
      await waitForExpr(tzPage, "document.querySelectorAll('.rival-card').length===4");
      const dayTabs = await evaluate(tzPage, "[...document.querySelectorAll('.pred-day-tab')].map(e=>(e.textContent||'').replace(/\\s+/g,' ').trim())");
      t('UTC+12: the prediction day tabs start at Today, not yesterday', /Today/.test(String(dayTabs[0] || '')), JSON.stringify(dayTabs.slice(0, 3)));
      const tzSummary = await evaluate(tzPage, "((document.querySelector('#dash-summary')||{}).textContent||'').replace(/\\s+/g,'')");
      t('UTC+12: the summary counts the game logged today', /Today1gamelogged/.test(tzSummary), tzSummary.slice(0, 200));
      // The heatmap lives on a rival page; cells carry their ISO day in `title`.
      await hashTo(tzPage, '#rival/r-ari', 1500);
      const heat = await evaluate(tzPage, "(()=>{const cells=[...document.querySelectorAll('#heatmap-grid .heatmap-cell:not(.heatmap-empty)')]; const last=cells[cells.length-1]; return {last: last && last.title.slice(0,10), cells: cells.length}})()");
      t('UTC+12: the calendar heatmap ends on the browser local today, not yesterday',
        heat.last === bToday, `${heat.last} vs ${bToday} (${heat.cells} cells)`);
      t('UTC+12: no first-party JS errors under an overridden timezone', cleanErrors(tzPage).length === 0, cleanErrors(tzPage).join(' | '));
    } finally {
      await closePage(cdpPort, tzPage);
    }

    t('no first-party JS errors across the suite', cleanErrors(s).length === 0, cleanErrors(s).join(' | '));
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  } catch (e) {
    // Name the last check that started, so a driver-level abort (the CDP
    // send timeout) points at the step that hung instead of just "timeout".
    t('maptap-rivals quality suite completed', false, `${String(e && e.message || e)} (last step: ${step})`);
  } finally {
    if (s) await closePage(cdpPort, s);
  }
  return R;
}
