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
  async function axe(s, label) {
    await s.send('Runtime.evaluate', { expression: axeSource, returnByValue: false });
    const v = await evalAsync(s, `window.axe.run(document.querySelector('main.page') || document, { runOnly: { type: 'tag', values: ['wcag2a','wcag2aa','wcag21aa'] }, resultTypes: ['violations'] }).then(r => r.violations.filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => v.id + ' [' + v.impact + '] x' + v.nodes.length + ' @ ' + (v.nodes[0].target||[]).join(' ')))`);
    t(`a11y ${label}: no serious/critical axe violations on rendered content`, Array.isArray(v) && v.length === 0, Array.isArray(v) ? v.join(' | ') : JSON.stringify(v));
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
      await goto(s, `${base}${APP}#${v}`, { settle: 1200 });
      await axe(s, `${v} @1280`);
    }
    await goto(s, `${base}${APP}#dashboard`, { settle: 1000 });
    await clickSel(s, '#add-rival-btn', { settle: 300 });
    await axe(s, 'rival modal');
    await pressKey(s, 'Escape', 'Escape', 27); await sleep(200);

    // ---- #13 keyboard ----
    t('rival cards expose a real link to the rival page', (await evaluate(s, "document.querySelectorAll('.rival-card .rival-card-link[href^=\"#rival/\"]').length")) === 4);
    await evaluate(s, "document.querySelector('.rival-card-link').focus()");
    await pressKey(s, 'Enter', 'Enter', 13); await sleep(600);
    t('Enter on a rival card link opens that rival page', (await evaluate(s, 'location.hash')) === '#rival/r-ari' && (await txt(s, '#rival-header h2')) === 'Ari', await evaluate(s, 'location.hash'));
    await goto(s, `${base}${APP}#leaderboard`, { settle: 1000 });
    t('leaderboard rows carry a link and headers are real buttons with aria-sort on the th', (await evaluate(s, "document.querySelectorAll('.lb-rival-link').length")) >= 3 && (await evaluate(s, "document.querySelectorAll('th[aria-sort] > .lb-sort-btn').length")) === 9);
    await evaluate(s, "document.querySelector('#lb-th-games .lb-sort-btn').focus()");
    await pressKey(s, 'Enter', 'Enter', 13, 0, '\r'); await sleep(300);
    t('Enter on a focused sort button sorts (aria-sort=descending)', (await evaluate(s, "document.getElementById('lb-th-games').getAttribute('aria-sort')")) === 'descending');
    const focusStyles = await evaluate(s, `(()=>{const out={}; for (const sel of ['#my-name','#my-icon-btn','.view-tab','.lb-sort-btn']) { const e=document.querySelector(sel); e.focus(); const cs=getComputedStyle(e); out[sel]=cs.outlineStyle+' '+cs.outlineWidth; } return out})()`);
    t('settings-strip controls and tabs show a visible focus outline', Object.values(focusStyles).every(v => /solid|auto/.test(v) && !/0px/.test(v)), JSON.stringify(focusStyles));

    // ---- modal focus trap + return ----
    await goto(s, `${base}${APP}#dashboard`, { settle: 1000 });
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
    await goto(s, `${base}${APP}#dashboard`, { settle: 1000 });
    await setFile('#wa-import-file', wa12);
    t('WhatsApp: 12-hour Android export opens the importer with the detected format', !(await evaluate(s, "document.getElementById('wa-modal').hidden")) && /2 messages/.test(await txt(s, '#wa-overview')) && /12-hour clock/.test(await txt(s, '#wa-format')), await txt(s, '#wa-overview') + ' ' + await txt(s, '#wa-format'));
    await pressKey(s, 'Escape', 'Escape', 27); await sleep(200);
    await setFile('#wa-import-file', waIos);
    t('WhatsApp: iPhone bracketed export with day-first dates is read as day/month/year', !(await evaluate(s, "document.getElementById('wa-modal').hidden")) && /iPhone export/.test(await txt(s, '#wa-format')) && (await evaluate(s, "document.getElementById('wa-date-order').value")) === 'DMY', await txt(s, '#wa-format'));
    await pressKey(s, 'Escape', 'Escape', 27); await sleep(200);

    // ---- #14 responsive containment ----
    for (const [w, h, mobile] of [[390, 844, true], [1100, 900, false]]) {
      await setViewport(s, w, h, mobile);
      for (const v of ['dashboard', 'rival/r-long', 'leaderboard', 'matrix', 'records', 'history']) {
        mark(`overflow ${w}px ${v}`);
        await goto(s, `${base}${APP}#${v}`, { settle: 900 });
        if (v === 'dashboard') { await clickSel(s, '.pred-label-toggle', { nth: 0, settle: 200 }); }
        const ov = await evaluate(s, OVERFLOW);
        t(`${w}px ${v}: no page-level horizontal scroll`, ov.scrollW <= ov.clientW + 1, JSON.stringify(ov));
      }
    }
    await setViewport(s, 390, 844, true);
    await goto(s, `${base}${APP}#dashboard`, { settle: 1200 });
    const tabs = await evaluate(s, "(()=>{const n=document.querySelector('.view-tabs'); return {scroll:n.dataset.scroll, mask: getComputedStyle(n).maskImage !== 'none' || getComputedStyle(n).webkitMaskImage !== 'none', scrollable: n.scrollWidth > n.clientWidth}})()");
    t('390px: the tab strip is scrollable and fades its overflowing edge', tabs.scrollable && tabs.scroll === 'start' && tabs.mask, JSON.stringify(tabs));
    const days = await evaluate(s, "(()=>{const n=document.querySelector('.pred-day-tabs'); const r=n.getBoundingClientRect(); return {tabs:n.children.length, fit: n.scrollWidth <= n.clientWidth + 1, minFont: Math.min(...[...n.querySelectorAll('.pred-day-tab-name')].map(e=>parseFloat(getComputedStyle(e).fontSize)))}})()");
    t('390px: all 7 prediction day tabs fit without scrolling, text >= 10px', days.tabs === 7 && days.fit && days.minFont >= 10, JSON.stringify(days));
    const smallest = await evaluate(s, "(()=>{let min=99; for (const e of document.querySelectorAll('#todays-card *')) { if (!e.textContent.trim() || e.children.length) continue; min=Math.min(min, parseFloat(getComputedStyle(e).fontSize)); } return min})()");
    t('390px: no prediction-card text under 10px', smallest >= 10, String(smallest));
    mark('axe dashboard @390');
    await axe(s, 'dashboard @390');
    await goto(s, `${base}${APP}#matrix`, { settle: 1000 });
    const mx = await evaluate(s, "(()=>{const cells=[...document.querySelectorAll('.matrix-cell')]; const over=cells.filter(c=>{const r=c.querySelector('.matrix-record'); return r && r.scrollWidth>c.clientWidth+1}).length; const heads=[...document.querySelectorAll('.matrix-row-head')].filter(h=>h.scrollWidth>h.clientWidth+1).length; const wrap=document.getElementById('matrix-wrap'); const chip=[...document.querySelectorAll('.matrix-chip')].find(c=>/Bartholomew/.test(c.textContent)); return {over, heads, wrapScrolls: wrap.scrollWidth>wrap.clientWidth, chipInside: chip.getBoundingClientRect().right <= document.querySelector('.matrix-controls').getBoundingClientRect().right + 1}})()");
    t('390px matrix: scrolls inside its wrap, no cell or row-head overflow, long chip contained', mx.over === 0 && mx.heads === 0 && mx.wrapScrolls && mx.chipInside, JSON.stringify(mx));
    mark('axe matrix @390');
    await axe(s, 'matrix @390');
    await goto(s, `${base}${APP}#rival/r-long`, { settle: 1000 });
    const longName = await evaluate(s, "(()=>{const h=document.querySelector('#rival-header h2'); const r=h.getBoundingClientRect(); return {right: Math.round(r.right), vw: innerWidth, overflow: h.scrollWidth > h.clientWidth + 1}})()");
    t('390px: a 57-character rival name wraps inside the header', longName.right <= longName.vw && !longName.overflow, JSON.stringify(longName));
    await setViewport(s, 1280, 900);
    await goto(s, `${base}${APP}#dashboard`, { settle: 1000 });
    const longCard = await evaluate(s, "(()=>{const c=[...document.querySelectorAll('.dash-summary-card')].find(c=>/Bartholomew/.test(c.textContent)); if(!c) return {none:true}; const v=c.querySelector('.value'); return {overflow: v.scrollWidth > v.clientWidth + 1, cardRight: Math.round(c.getBoundingClientRect().right), stripRight: Math.round(document.getElementById('dash-summary').getBoundingClientRect().right)}})()");
    t('1280px: a long name in a summary card wraps instead of overflowing', longCard.none || (!longCard.overflow && longCard.cardRight <= longCard.stripRight + 1), JSON.stringify(longCard));

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
