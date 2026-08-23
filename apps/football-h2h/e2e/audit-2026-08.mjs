// Football H2H: browser regressions for the 2026-08-22 site-wide audit.
//
// Raw CDP through tests/browser/cdp.mjs, same pattern as apps/fpl-planner/e2e.
// Every check here reproduced as a defect in the browser before the fix:
// stored XSS in the modal layer (D1/D2), id-less rows deleted en masse (D3),
// two tabs clobbering each other (D4), the hidden shootout field (D5), the
// unclamped page (D6), the live undo stack after a clear (D7), the icon
// picker under the sidebar (D8), the closed sidebar in the Tab order (D9),
// unnamed selects and mouse-only sort headers (D11), corrupted storage (D12),
// off-screen scores on phones (D13), contrast (D21), focus after Save (D22).
import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  newPage, closePage, goto, evaluate, evalAsync, waitForExpr, clickAt, clickSel,
  setViewport, setValue, pressKey, screenshot, sleep, cleanErrors,
} from '../../../tests/browser/cdp.mjs';

const APP = '/apps/football-h2h/index.html';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const ART_DIR = path.join(REPO, '.screenshots', 'e2e-football-h2h');
const AXE_PATH = path.join(REPO, 'tests', 'browser', 'vendor', 'axe.min.js');

const HOSTILE_NOTE = 'x"><img src=x onerror=window.__xssNote=1>';
// 25 chars: player names are capped at 30 on every write path, so the
// payload has to fit inside the cap to reach the modal at all.
const HOSTILE_NAME = 'Al<svg onload=window.__n=1>';
const QUOTED = `He said "nice" & 'ok' <b>`;

function recorder(R) {
  return async (name, pass, detail = '', s = null) => {
    R.push({ name, pass: !!pass, detail: detail ? String(detail).slice(0, 240) : '' });
    if (!pass && s) {
      try {
        await mkdir(ART_DIR, { recursive: true });
        const file = path.join(ART_DIR, name.replace(/[^a-z0-9_-]+/gi, '_').slice(0, 80) + '.png');
        await screenshot(s, file);
        R[R.length - 1].detail += ` [shot: ${path.relative(REPO, file)}]`;
      } catch { /* never mask the failure */ }
    }
  };
}

async function shot(s, label) {
  await mkdir(ART_DIR, { recursive: true });
  const file = path.join(ART_DIR, label + '.png');
  await screenshot(s, file);
  return path.relative(REPO, file);
}

// A seeded games list: n games dated today (so every filter keeps them).
function seedGames(n, extra = {}) {
  return `(()=>{const g=[];for(let i=0;i<${n};i++){const d=new Date();d.setHours(9+i%10,i%60,0,0);
    g.push({id:1000+i,gameNumber:i+1,player1Goals:i%4,player2Goals:(i+1)%3,penaltyWinner:(i%4===(i+1)%3)?1:null,
      player1Team:'Ultimate Team',player2Team:'Ultimate Team',dateTime:d.toISOString(),...${JSON.stringify(extra)}})}
    localStorage.clear(); localStorage.setItem('footballH2HGames',JSON.stringify(g)); return g.length})()`;
}

async function open(cdpPort, base, { width = 1280, height = 900, mobile = false, seed = null } = {}) {
  const s = await newPage(cdpPort);
  await setViewport(s, width, height, mobile);
  await goto(s, base + APP, { settle: 800 });
  if (seed) { await evaluate(s, seed); await goto(s, base + APP, { settle: 800 }); }
  return s;
}

const games = (s) => evaluate(s, `JSON.parse(localStorage.getItem('footballH2HGames')||'[]')`);
const openSidebar = (s) => evaluate(s, `(()=>{if(!document.querySelector('.sidebar.open')) toggleSidebar(); return 1})()`);
const openForm = async (s) => { await evaluate(s, `(()=>{if(!document.querySelector('#sidebar-game-form.open')) toggleSidebarGameForm(); return 1})()`); await sleep(250); };
async function addGame(s, p1, p2, pen, note) {
  await openSidebar(s); await openForm(s);
  await setValue(s, '#sidebar-player1-goals', String(p1));
  await setValue(s, '#sidebar-player2-goals', String(p2));
  if (pen !== undefined) await setValue(s, '#sidebar-penalty-winner', String(pen));
  if (note !== undefined) await setValue(s, '#sidebar-game-note', note);
  await evaluate(s, 'submitSidebarGame()');
  await sleep(150);
  return evaluate(s, `(()=>{const e=document.getElementById('sidebar-game-error');return e.classList.contains('show')?e.textContent:''})()`);
}
const clickModalBtn = (s, cls) => evaluate(s, `(()=>{const b=[...document.querySelectorAll('.modal-buttons button')].find(x=>x.classList.contains('${cls}'));if(!b)return false;b.click();return true})()`);
const rowScores = (s) => evaluate(s, `[...document.querySelectorAll('#gamesTableBody tr')].map(r=>r.querySelector('.player1-score .score-number').textContent+'-'+r.querySelector('.player2-score .score-number').textContent)`);

async function axeScan(s, axeSource) {
  await s.send('Runtime.evaluate', { expression: axeSource, returnByValue: false });
  return evalAsync(s, `window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a','wcag2aa','wcag21a','wcag21aa','best-practice'] } })
    .then(r => r.violations.filter(v => v.impact === 'serious' || v.impact === 'critical')
      .map(v => v.id + ':' + v.nodes.slice(0,3).map(n => n.target.join(' ')).join('|')))`);
}

export async function run({ base, cdpPort }) {
  const R = [];
  const rec = recorder(R);
  const axeSource = await readFile(AXE_PATH, 'utf8');

  /* ---------------------------------------------- D1 / D2: modal escaping */
  {
    const seed = `(()=>{localStorage.clear();const d=new Date().toISOString();
      localStorage.setItem('footballH2HGames',JSON.stringify([
        {id:1,gameNumber:1,player1Goals:1,player2Goals:0,player1Team:${JSON.stringify(HOSTILE_NOTE)},player2Team:'Ultimate Team',penaltyWinner:null,dateTime:d,note:${JSON.stringify(HOSTILE_NOTE)}},
        {id:2,gameNumber:2,player1Goals:2,player2Goals:2,player1Team:'Bob"s XI',player2Team:'Ultimate Team',penaltyWinner:1,dateTime:d,note:${JSON.stringify(QUOTED)}}]));
      localStorage.setItem('footballH2HPlayers',JSON.stringify({player1:${JSON.stringify(HOSTILE_NAME)},player2:'Sam'}));return 1})()`;
    const s = await open(cdpPort, base, { seed });
    try {
      await evaluate(s, 'editGame(1)'); await sleep(250);
      const edit = await evaluate(s, `({value:document.getElementById('form-note').value, team:document.getElementById('form-player1Team').value,
        imgs:document.querySelectorAll('.modal-overlay img, .modal-overlay svg').length, fired:!!window.__xssNote||!!window.__n,
        label:document.querySelector('label[for="form-player1Goals"]').textContent})`);
      await rec('edit modal: a hostile note renders verbatim in the field', edit.value === HOSTILE_NOTE, JSON.stringify(edit.value), s);
      await rec('edit modal: a hostile custom team renders verbatim', edit.team === HOSTILE_NOTE, JSON.stringify(edit.team), s);
      await rec('edit modal: no element is created and no script runs', edit.imgs === 0 && !edit.fired, JSON.stringify(edit), s);
      await rec('edit modal: the player name appears as text in labels', edit.label.includes(HOSTILE_NAME), edit.label, s);
      await clickModalBtn(s, 'modal-btn-secondary'); await sleep(200);

      await evaluate(s, 'editGame(2)'); await sleep(250);
      const before = await evaluate(s, `document.getElementById('form-note').value`);
      await rec('edit modal: a quoted note is intact when the modal opens', before === QUOTED, JSON.stringify(before), s);
      await clickModalBtn(s, 'modal-btn-primary'); await sleep(250);
      const stored = (await games(s)).find(g => g.id === 2);
      await rec('a no-op Save keeps the quoted note and team', stored.note === QUOTED && stored.player1Team === 'Bob"s XI', JSON.stringify([stored.note, stored.player1Team]), s);
      await evaluate(s, 'editGame(2)'); await sleep(250);
      const again = await evaluate(s, `document.getElementById('form-note').value`);
      await rec('the second edit still shows the full note', again === QUOTED, JSON.stringify(again), s);
      await clickModalBtn(s, 'modal-btn-secondary'); await sleep(200);

      await evaluate(s, 'deleteGame(1)'); await sleep(250);
      const del = await evaluate(s, `({imgs:document.querySelectorAll('.modal-overlay img, .modal-overlay svg').length, fired:!!window.__n, text:document.querySelector('.modal-text').textContent})`);
      await rec('delete confirm: the player name is text, no element, no script', del.imgs === 0 && !del.fired && del.text.includes(HOSTILE_NAME), JSON.stringify(del), s);
      await clickModalBtn(s, 'modal-btn-secondary');
      await rec('no console errors in the escaping flow', cleanErrors(s).length === 0, cleanErrors(s).slice(0, 2).join(' | '), s);
    } finally { await closePage(cdpPort, s); }
  }

  /* ------------------------------------------------- D3: id-less imports */
  {
    const seed = `(()=>{localStorage.clear();localStorage.setItem('footballH2HGames',JSON.stringify([
      {player1Goals:1,player2Goals:0,dateTime:'2026-08-01T10:00:00'},
      {player1Goals:2,player2Goals:2,penaltyWinner:1,dateTime:'2026-08-02T10:00:00'},
      {player1Goals:0,player2Goals:1,dateTime:'2026-08-03T10:00:00'}]));return 1})()`;
    const s = await open(cdpPort, base, { seed });
    try {
      const ids = await evaluate(s, `JSON.parse(localStorage.getItem('footballH2HGames')).map(g=>g.id)`);
      await rec('id-less stored rows are healed with distinct numeric ids on load', ids.every(Number.isFinite) && new Set(ids).size === 3, JSON.stringify(ids), s);
      const onclicks = await evaluate(s, `[...document.querySelectorAll('#gamesTableBody .delete-btn')].map(b=>b.getAttribute('onclick'))`);
      await rec('no row renders deleteGame(undefined)', onclicks.every(o => !/undefined/.test(o)), JSON.stringify(onclicks), s);
      // Coordinate click on the 2-2 row's trash button.
      const box = await evaluate(s, `(()=>{const r=[...document.querySelectorAll('#gamesTableBody tr')].find(r=>r.querySelector('.player1-score .score-number').textContent==='2');
        const b=r.querySelector('.delete-btn'); b.scrollIntoView({block:'center'}); const q=b.getBoundingClientRect(); return {x:q.left+q.width/2,y:q.top+q.height/2}})()`);
      await clickAt(s, box.x, box.y); await sleep(300);
      const text = await evaluate(s, `(document.querySelector('.modal-text')||{}).textContent||''`);
      await rec('the confirm names the clicked game', /2 - 2/.test(text), text, s);
      await clickModalBtn(s, 'modal-btn-danger'); await sleep(300);
      const left = (await games(s)).map(g => `${g.player1Goals}-${g.player2Goals}`);
      await rec('deleting one formerly id-less row removes exactly that row', JSON.stringify(left) === JSON.stringify(['1-0', '0-1']), JSON.stringify(left), s);
    } finally { await closePage(cdpPort, s); }
  }

  /* -------------------------------------------------------- D4: two tabs */
  {
    const a = await open(cdpPort, base, { seed: seedGames(3) });
    const b = await newPage(cdpPort);
    try {
      await setViewport(b, 1280, 900);
      await goto(b, base + APP, { settle: 800 });
      await addGame(a, 9, 9, '1');
      await sleep(400);
      const bRows = await rowScores(b);
      await rec('tab B re-renders a game added in tab A', bRows.includes('9-9'), JSON.stringify(bRows), b);
      await addGame(b, 8, 8, '2');
      await sleep(400);
      const stored = (await games(b)).map(g => `${g.player1Goals}-${g.player2Goals}`);
      await rec('storage holds both tabs\' games', stored.includes('9-9') && stored.includes('8-8') && stored.length === 5, JSON.stringify(stored), b);
      const aRows = await rowScores(a);
      await rec('tab A renders both new games', aRows.includes('9-9') && aRows.includes('8-8'), JSON.stringify(aRows), a);
      // Delete 9-9 in B; A must not resurrect it on its next write.
      const id99 = (await games(b)).find(g => g.player1Goals === 9).id;
      await evaluate(b, `deleteGame(${id99})`); await sleep(200); await clickModalBtn(b, 'modal-btn-danger'); await sleep(400);
      await addGame(a, 7, 0);
      await sleep(300);
      const after = (await games(a)).map(g => `${g.player1Goals}-${g.player2Goals}`);
      await rec('a delete in tab B survives a later write from tab A', !after.includes('9-9') && after.includes('7-0') && after.includes('8-8'), JSON.stringify(after), a);
      const errs = cleanErrors(a).concat(cleanErrors(b)).filter(e => !/ShevatoTabSync/.test(e));
      await rec('no console errors across the two-tab flow', errs.length === 0, errs.slice(0, 2).join(' | '), a);
      const refused = cleanErrors(a).concat(cleanErrors(b)).filter(e => /ShevatoTabSync: refused/.test(e));
      await rec('the storage handler never writes (no refused writes logged)', refused.length === 0, refused.slice(0, 2).join(' | '), a);
    } finally { await closePage(cdpPort, a); await closePage(cdpPort, b); }
  }

  /* ----------------------------------------------- D5 / D22 / UX: the form */
  {
    const s = await open(cdpPort, base, { seed: seedGames(2) });
    try {
      await openSidebar(s); await openForm(s);
      const focused = await evaluate(s, `document.activeElement && document.activeElement.id`);
      await rec('opening Add Game focuses the first goals field', focused === 'sidebar-player1-goals', focused, s);
      await setValue(s, '#sidebar-player1-goals', '2');
      await setValue(s, '#sidebar-player2-goals', '02');
      const vis = await evaluate(s, `getComputedStyle(document.getElementById('sidebar-penalty-section')).display`);
      await rec('2 vs 02 shows the penalty field (numeric draw detection)', vis === 'block', vis, s);
      await setValue(s, '#sidebar-penalty-winner', '1');
      await evaluate(s, `document.getElementById('sidebar-player2-goals').focus()`);
      await pressKey(s, 'Enter', 'Enter', 13);
      await sleep(300);
      const n = (await games(s)).length;
      await rec('Enter inside a goals field saves the game', n === 3, `games=${n}`, s);
      const after = await evaluate(s, `document.activeElement && document.activeElement.id`);
      await rec('focus lands on the Add Game button after Save, not <body>', after === 'sidebar-add-game-btn', after, s);
      await openForm(s);
      await setValue(s, '#sidebar-player1-goals', '1e2');
      await setValue(s, '#sidebar-player2-goals', '0');
      const err = await addGame(s, '1e2', '0');
      await rec('scientific notation is rejected', /0 to 99/.test(err), err, s);
    } finally { await closePage(cdpPort, s); }
  }

  /* --------------------------------------------------- D6 / D7 / D12 */
  {
    const s = await open(cdpPort, base, { seed: seedGames(250) });
    try {
      await evaluate(s, `GlobalPaginationManager.setRowsPerPage('football-h2h-games', 50)`);
      await evaluate(s, `GlobalPaginationManager.goToPage('football-h2h-games', 5)`); await sleep(200);
      // Custom filter that keeps the 6 games stamped 09:00-09:05 (i=0,10,...)? Simpler: delete enough via storage + re-filter.
      await evaluate(s, `(()=>{games=games.slice(0,6);window.games=games;saveGames();updateUI();return 1})()`); await sleep(200);
      const pg = await evaluate(s, `({rows:document.querySelectorAll('#gamesTableBody tr').length, info:(document.querySelector('.pagination-info')||{}).textContent||''})`);
      await rec('the page clamps when rows shrink below the current page', pg.rows === 6 && /Showing 1-6 of 6/.test(pg.info), JSON.stringify(pg), s);

      // D7
      const id = (await games(s))[0].id;
      await evaluate(s, `deleteGame(${id})`); await sleep(150); await clickModalBtn(s, 'modal-btn-danger'); await sleep(200);
      await evaluate(s, 'confirmClearData()'); await sleep(150); await clickModalBtn(s, 'modal-btn-danger'); await sleep(200);
      await clickModalBtn(s, 'modal-btn-primary'); await sleep(150);
      const undo = await evaluate(s, `({disabled:document.getElementById('sidebar-undo-btn').disabled, n:JSON.parse(localStorage.getItem('footballH2HGames')).length})`);
      await evaluate(s, 'undoLastAction()'); await sleep(150);
      const n2 = (await games(s)).length;
      await rec('Clear All Data disables Undo and undo does not resurrect a game', undo.disabled && undo.n === 0 && n2 === 0, JSON.stringify({ undo, n2 }), s);

      // D17: filtered empty state copy
      await evaluate(s, seedGames(3)); await goto(s, base + APP, { settle: 800 });
      await evaluate(s, `(()=>{games.forEach(g=>{g.dateTime='2025-01-01T10:00:00.000Z'});saveGames();setDateFilter('today');return 1})()`); await sleep(200);
      const empty = await evaluate(s, `({shown:getComputedStyle(document.getElementById('noGames')).display, text:document.getElementById('noGames').textContent.trim()})`);
      await rec('a filter that hides every game says so instead of "No games recorded yet"', empty.shown === 'block' && /0 of 3 games/.test(empty.text), JSON.stringify(empty), s);

      // D12
      await evaluate(s, `localStorage.setItem('footballH2HGames','{not json')`);
      await goto(s, base + APP, { settle: 800 });
      const errs = cleanErrors(s);
      const notice = await evaluate(s, `({shown:getComputedStyle(document.getElementById('noGames')).display, text:document.getElementById('noGames').textContent})`);
      await rec('corrupted storage: no uncaught errors and a visible notice', errs.length === 0 && notice.shown === 'block' && /could not be read/.test(notice.text), JSON.stringify({ errs: errs.slice(0, 2), notice }), s);
      await addGame(s, 1, 0); await sleep(200);
      const blob = await evaluate(s, `localStorage.getItem('footballH2HGames')`);
      await rec('corrupted storage: an Add does not overwrite the unreadable blob', blob === '{not json', blob, s);
    } finally { await closePage(cdpPort, s); }
  }

  /* --------------------------------------------- D9 / D11 / D21: keyboard + a11y */
  {
    const s = await open(cdpPort, base, { seed: seedGames(4) });
    try {
      await evaluate(s, `document.getElementById('sidebar-toggle').focus()`);
      await pressKey(s, 'Tab', 'Tab', 9);
      const focus = await evaluate(s, `(()=>{const e=document.activeElement;return {id:e.id||e.className, inSidebar:!!e.closest('#sidebar'), x:e.getBoundingClientRect().left}})()`);
      await rec('Tab from the toggle with the sidebar closed skips the sidebar', !focus.inSidebar && focus.x >= 0, JSON.stringify(focus), s);
      const inert = await evaluate(s, `document.getElementById('sidebar').hasAttribute('inert')`);
      await rec('the closed sidebar is inert', inert === true, String(inert), s);
      await openSidebar(s); await sleep(300);
      const inertOpen = await evaluate(s, `document.getElementById('sidebar').hasAttribute('inert')`);
      await rec('the open sidebar is not inert', inertOpen === false, String(inertOpen), s);
      await evaluate(s, 'closeSidebar()'); await sleep(300);

      await evaluate(s, `document.querySelector('th[data-sort="game"]').focus()`);
      await pressKey(s, 'Enter', 'Enter', 13);
      const sort = await evaluate(s, `({aria:document.querySelector('th[data-sort="game"]').getAttribute('aria-sort'), first:document.querySelector('#gamesTableBody td.game-number').textContent})`);
      await rec('Enter on a sortable header sorts and sets aria-sort', sort.aria === 'ascending' && sort.first === '1', JSON.stringify(sort), s);
      await pressKey(s, ' ', 'Space', 32);
      const sort2 = await evaluate(s, `({aria:document.querySelector('th[data-sort="game"]').getAttribute('aria-sort'), first:document.querySelector('#gamesTableBody td.game-number').textContent})`);
      await rec('Space toggles the direction (Game # sorts by the displayed number)', sort2.aria === 'descending' && sort2.first === '4', JSON.stringify(sort2), s);

      const contrast = await evaluate(s, `getComputedStyle(document.querySelector('.sidebar-section-title')).color`);
      await rec('sidebar section titles use the readable muted token', contrast === 'rgb(164, 173, 189)', contrast, s);

      // axe: General tab, Player tab, sidebar open with form + Manage Players, edit modal.
      await evaluate(s, `switchStatsTab('general')`); await sleep(200);
      let v = await axeScan(s, axeSource);
      await rec('axe: General Stats tab has no serious/critical violations', v.length === 0, v.join(' ; '), s);
      await evaluate(s, `switchStatsTab('player')`); await sleep(200);
      v = await axeScan(s, axeSource);
      await rec('axe: Player Stats tab has no serious/critical violations', v.length === 0, v.join(' ; '), s);
      await evaluate(s, `switchStatsTab('h2h')`);
      await openSidebar(s); await openForm(s); await evaluate(s, 'toggleSidebarPlayerSettings()'); await sleep(300);
      v = await axeScan(s, axeSource);
      await rec('axe: sidebar open with Add Game + Manage Players has no serious/critical violations', v.length === 0, v.join(' ; '), s);
      await evaluate(s, 'closeSidebar()'); await sleep(200);
      await evaluate(s, `editGame(1000)`); await sleep(300);
      v = await axeScan(s, axeSource);
      await rec('axe: edit modal has no serious/critical violations', v.length === 0, v.join(' ; '), s);
      await clickModalBtn(s, 'modal-btn-secondary');
    } finally { await closePage(cdpPort, s); }
  }

  /* ------------------------------------------ D8 / D13 / toast: phones */
  for (const width of [360, 390]) {
    const s = await open(cdpPort, base, { width, height: 844, mobile: true, seed: seedGames(3) });
    try {
      const geo = await evaluate(s, `(()=>{const c=document.querySelector('.table-container');const cells=[...document.querySelectorAll('#gamesTableBody tr:first-child .score-number')].map(e=>e.getBoundingClientRect().right);
        return {scroll:c.scrollWidth, client:c.clientWidth, docScroll:document.documentElement.scrollWidth, vw:window.innerWidth, scoresRight:cells}})()`);
      await rec(`${width}px: the history table fits without horizontal scrolling`, geo.scroll <= geo.client && geo.docScroll <= geo.vw, JSON.stringify(geo), s);
      await rec(`${width}px: both score circles are inside the viewport`, geo.scoresRight.length === 2 && geo.scoresRight.every(r => r <= geo.vw), JSON.stringify(geo.scoresRight), s);
      await evaluate(s, `(document.querySelector('.game-history').scrollIntoView({block:'start'}), 1)`); await sleep(200);
      await shot(s, `table-${width}`);
      await evaluate(s, 'window.scrollTo(0,0)');

      await openSidebar(s); await evaluate(s, 'toggleSidebarPlayerSettings()'); await sleep(300);
      await evaluate(s, 'openIconSelector(1)'); await sleep(300);
      // The picker body scrolls, so each icon is scrolled into view first; what
      // matters is that nothing (the sidebar) sits on top of it.
      const hit = await evaluate(s, `(()=>{const items=[...document.querySelectorAll('#sportsIconGrid .icon-item')];let ok=0;for(const it of items){it.scrollIntoView({block:'center'});const r=it.getBoundingClientRect();const e=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);if(e&&e.closest('.icon-item')===it)ok++}return {ok,total:items.length}})()`);
      await rec(`${width}px: every icon in the picker is the top element at its centre`, hit.total > 0 && hit.ok === hit.total, JSON.stringify(hit), s);
      await shot(s, `icon-picker-${width}`);
      await evaluate(s, 'closeIconSelector()'); await sleep(200);

      await openForm(s);
      await setValue(s, '#sidebar-player1-goals', '3'); await setValue(s, '#sidebar-player2-goals', '1');
      await evaluate(s, 'submitSidebarGame()'); await sleep(200);
      const toast = await evaluate(s, `(()=>{const t=document.querySelector('.toast');if(!t)return null;const r=t.getBoundingClientRect();const c=document.getElementById('sidebar-clear-btn').getBoundingClientRect();
        const overlap=!(r.right<c.left||r.left>c.right||r.bottom<c.top||r.top>c.bottom);return {top:r.top,bottom:r.bottom,vh:window.innerHeight,overlap}})()`);
      await rec(`${width}px: the toast sits at the bottom, clear of the sidebar controls`, toast && !toast.overlap && toast.bottom <= toast.vh && toast.top > toast.vh / 2, JSON.stringify(toast), s);
      await shot(s, `toast-${width}`);
    } finally { await closePage(cdpPort, s); }
  }

  /* ------------------------------------------------ tablet / desktop shots */
  for (const [w, h] of [[768, 1024], [1024, 768], [1280, 900]]) {
    const s = await open(cdpPort, base, { width: w, height: h, seed: seedGames(3) });
    try {
      const geo = await evaluate(s, `({docScroll:document.documentElement.scrollWidth, vw:window.innerWidth})`);
      await rec(`${w}px: no horizontal page overflow`, geo.docScroll <= geo.vw, JSON.stringify(geo), s);
      await evaluate(s, `(document.querySelector('.game-history').scrollIntoView({block:'start'}), 1)`); await sleep(200);
      await shot(s, `table-${w}`);
    } finally { await closePage(cdpPort, s); }
  }

  const passed = R.filter(r => r.pass).length;
  const failed = R.filter(r => !r.pass).length;
  return { passed, failed, skipped: 0, failures: R.filter(r => !r.pass).map(r => `${r.name}: ${r.detail}`) };
}
