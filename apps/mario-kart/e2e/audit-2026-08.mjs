// Mario Kart E2E: the 2026-08-22 site-audit regressions that only a real
// browser can prove (DOM creation from stored strings, modal focus and
// listener lifecycle, two tabs on one origin, touch geometry, axe on seeded
// states). The node suites under ../tests pin the data layer; nothing pure
// is repeated here. Same contract as apps/fpl-planner/e2e: returns an array
// of { name, pass, detail }.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  newPage, closePage, goto, evaluate, evalAsync, waitForExpr, clickSel, clickAt,
  setViewport, pressKey, sleep, cleanErrors, screenshot,
} from '../../../tests/browser/cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const AXE_PATH = path.join(REPO, 'tests', 'browser', 'vendor', 'axe.min.js');
const APP = '/apps/mario-kart/index.html';

// Hostile but within the 40-character name cap, so the same literal can be
// asserted to round-trip through a player name as well as a course tag.
const HOSTILE = `<img src=x onerror="pwn()"> "B" & 'C'`;

function mkRace(date, p, extra = {}) {
  const r = { date, timestamp: '12:00:00 CDT', player1: null, player2: null, player3: null, player4: null, ...extra };
  p.forEach((v, i) => { r['player' + (i + 1)] = v; });
  return r;
}
const SEVEN = [
  mkRace('2026-08-10', [1, 2, 3]), mkRace('2026-08-11', [2, 1, 3]), mkRace('2026-08-12', [3, 1, 2]),
  mkRace('2026-08-13', [1, 3, 2]), mkRace('2026-08-14', [2, 3, 1]), mkRace('2026-08-15', [1, 2, 3]),
  mkRace('2026-08-16', [3, 2, 1], { course: 'Rainbow Road' }),
];

const STORAGE = (seed) => `(()=>{ localStorage.clear(); sessionStorage.clear();
  const kv=${JSON.stringify(seed)}; for (const [k,v] of Object.entries(kv)) localStorage.setItem(k, typeof v==='string'?v:JSON.stringify(v)); return 1 })()`;

async function open(cdpPort, base, { seed = {}, viewport = [1280, 900, false], hash = '' } = {}) {
  const s = await newPage(cdpPort);
  await setViewport(s, ...viewport);
  await goto(s, base + APP, { settle: 500 });
  await evaluate(s, STORAGE(seed));
  // A navigation that differs only by the fragment is a SAME-DOCUMENT
  // navigation: the app would keep its pre-seed state and every assertion
  // below would run against an empty log. Go through about:blank so the
  // seeded page is a real load.
  await goto(s, 'about:blank', { settle: 150 });
  await goto(s, base + APP + hash, { settle: 1800 });
  const seeded = await evaluate(s, `Object.keys(localStorage).filter(k => k.startsWith('marioKart')).length`);
  if (Object.keys(seed).length && !seeded) throw new Error('seed did not survive the reload');
  s.errors.length = 0;
  return s;
}
const errs = (s) => cleanErrors(s).filter((e) => !/ShevatoTabSync: refused/.test(e));
const racesIn = (s, key = 'marioKartRaces') => evaluate(s, `JSON.parse(localStorage.getItem(${JSON.stringify(key)})||'[]')`);
const view = (s, name) => evaluate(s, `(()=>{ toggleView(${JSON.stringify(name)}); return currentView })()`);
async function openRaceForm(s) {
  await evaluate(s, `(()=>{ if (!document.querySelector('.sidebar').classList.contains('open')) openSidebar(); return 1 })()`);
  await sleep(400);
  const open = await evaluate(s, `document.getElementById('sidebar-race-form').classList.contains('open')`);
  if (!open) await clickSel(s, '#sidebar-add-race-btn', { settle: 700 });
  // A coordinate click into a BACKGROUND tab (the two-tab block keeps two
  // pages alive) does not always land, and a form that never opened would
  // read as a cross-tab failure rather than as the click plumbing it is.
  // The click path is exercised for real in the phone-geometry block; here,
  // fall back to the app's own toggle so the assertion stays about tabs.
  const ready = await waitForExpr(s, `!!document.getElementById('sidebar-player1')`, { timeout: 2500 }).catch(() => false);
  if (!ready) {
    await evaluate(s, `(()=>{ toggleSidebarRaceForm(); return 1 })()`);
    await sleep(500);
  }
}
async function addViaSidebar(s, positions) {
  await openRaceForm(s);
  const set = await evaluate(s, `(()=>{ const v=${JSON.stringify(positions)}; const out={}; for (const [k,val] of Object.entries(v)) { const e=document.getElementById('sidebar-'+k); if(!e){out[k]='missing';continue;} e.value=val; e.dispatchEvent(new Event('input',{bubbles:true})); out[k]=e.value; } return out })()`);
  await clickSel(s, '.sidebar-submit-race', { settle: 700 });
  return evaluate(s, `(()=>{ const e=document.getElementById('sidebar-race-error'); return { set: ${JSON.stringify('X')}, error: e ? e.textContent : null, mem: races.length } })()`)
    .then((r) => ({ ...r, set }));
}

export async function run({ base, cdpPort }) {
  const R = [];
  const t = (name, pass, detail = '') => R.push({ name, pass: !!pass, detail: detail ? String(detail).slice(0, 220) : '' });
  const axeSource = await readFile(AXE_PATH, 'utf8');
  const axe = async (s, label) => {
    await s.send('Runtime.evaluate', { expression: axeSource, returnByValue: false });
    const v = await evalAsync(s, `window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a','wcag2aa'] }, resultTypes: ['violations'] })
      .then(r => r.violations.filter(v => v.impact==='serious'||v.impact==='critical').map(v => v.id+' @ '+(v.nodes[0].target||[]).join(' ')))`);
    t(`axe (${label}): zero serious/critical violations`, Array.isArray(v) && v.length === 0, (v || []).join(' | '));
  };

  /* ---------------------------------------------- first run + stored XSS */
  {
    const s = await open(cdpPort, base);
    try {
      const cta = await evaluate(s, `!!document.querySelector('#stats-display .mk-empty-cta')`);
      t('empty boot: the Help view carries an Add Race call to action', cta);
      await clickSel(s, '#stats-display .mk-empty-cta', { settle: 900 });
      const opened = await evaluate(s, `document.querySelector('.sidebar').classList.contains('open') && document.getElementById('sidebar-race-form').classList.contains('open')`);
      t('the call to action opens the sidebar with the race form ready', opened);
      t('no console errors on first run', errs(s).length === 0, errs(s).join(' | '));
    } finally { await closePage(cdpPort, s); }
  }
  {
    const seed = {
      marioKartRaces: [...SEVEN, mkRace('2026-08-17', [1, 2, 3], { course: HOSTILE })],
      marioKartPlayerNames: { player1: HOSTILE, player2: 'Bob', player3: 'Cara' },
      marioKartPlayerSymbols: { player2: '<b>x</b>' },
      marioKartPlayerCount: '3',
    };
    const s = await open(cdpPort, base, { seed });
    try {
      // The load-path validator drops an unreadable timestamp, so a hostile
      // one can only reach a renderer from memory (a synced write that never
      // went through import). Put it there directly: the renderers must
      // escape it regardless of how it arrived.
      await evaluate(s, `(()=>{ races[7].timestamp = ${JSON.stringify(HOSTILE)}; updateDisplay(); return 1 })()`);
      const probe = async (label) => {
        await sleep(250);
        const r = await evaluate(s, `({ imgs: document.querySelectorAll('#stats-display img, .race-history img, .modal-dialog img, .sidebar img, #history-table img').length,
          pwn: window.__pwn === 1, bold: document.querySelectorAll('#stats-display b, .race-history b').length,
          text: document.body.innerText.includes(${JSON.stringify(HOSTILE)}) })`);
        t(`XSS ${label}: no element created from stored strings, text round-trips`, r.imgs === 0 && !r.pwn && r.bold === 0 && r.text, JSON.stringify(r));
      };
      const rows = await evaluate(s, `races.length`);
      t('the seeded 8-race log really loaded (guards every assertion below)', rows === 8, String(rows));
      for (const v of ['stats', 'h2h', 'analysis', 'trends', 'achievements', 'activity']) { await view(s, v); await probe(v); }
      await view(s, 'stats');
      await evaluate(s, `editRace(7)`); await sleep(300);
      const modal = await evaluate(s, `({ imgs: document.querySelectorAll('.modal-dialog img').length, label: document.querySelector('label[for="edit-player1"]').textContent.includes(${JSON.stringify(HOSTILE)}), meta: document.querySelector('.edit-race-meta').textContent.includes(${JSON.stringify(HOSTILE)}), attr: document.getElementById('edit-date').value })`);
      t('XSS edit modal: labels and meta line escape the hostile strings', modal.imgs === 0 && modal.label && modal.meta, JSON.stringify(modal));
      await pressKey(s, 'Escape', 'Escape', 27);
      await openRaceForm(s); await sleep(300);
      const form = await evaluate(s, `({ imgs: document.querySelectorAll('#sidebar-race-inputs img').length, ok: document.querySelector('label[for="sidebar-player1"]').textContent.includes(${JSON.stringify(HOSTILE)}) })`);
      t('XSS sidebar race form: player label escaped', form.imgs === 0 && form.ok, JSON.stringify(form));
      await evaluate(s, `openSidebarPlayerSettings()`); await sleep(300);
      const settings = await evaluate(s, `({ imgs: document.querySelectorAll('#sidebar-player-settings img').length, value: document.querySelector('#sidebar-player-settings input[data-player="player1"]').value === ${JSON.stringify(HOSTILE)}, maxlength: document.querySelector('#sidebar-player-settings input[data-player="player1"]').maxLength })`);
      t('XSS Manage Players: name input holds the text, maxlength 40', settings.imgs === 0 && settings.value && settings.maxlength === 40, JSON.stringify(settings));
      t('no console errors across every view with hostile data', errs(s).length === 0, errs(s).join(' | '));
      await axe(s, 'Stats, hostile names');
    } finally { await closePage(cdpPort, s); }
  }

  /* --------------------------------------------------- clear + undo, D1 */
  {
    const s = await open(cdpPort, base, { seed: { marioKartRaces: SEVEN, marioKartPlayerCount: '3' }, hash: '#stats' });
    try {
      await evaluate(s, `editRace(2)`); await sleep(200);
      await evaluate(s, `(()=>{ const i=document.getElementById('edit-player1'); i.value='4'; return 1 })()`);
      await clickSel(s, '#save-edit', { settle: 400 });
      await evaluate(s, `openSidebar()`); await sleep(300);
      await clickSel(s, '#sidebar-clear-btn', { settle: 400 });
      const dialog = await evaluate(s, `(()=>{ const d=document.querySelector('.modal-dialog'); return d ? { role: d.getAttribute('role'), modal: d.getAttribute('aria-modal'), labelled: !!d.getAttribute('aria-labelledby') && !!document.getElementById(d.getAttribute('aria-labelledby')), focusInside: d.contains(document.activeElement) } : null })()`);
      t('clear confirm has dialog semantics and focus inside', dialog && dialog.role === 'dialog' && dialog.modal === 'true' && dialog.labelled && dialog.focusInside, JSON.stringify(dialog));
      await clickSel(s, '#confirm-clear', { settle: 500 });
      t('clear empties storage', (await racesIn(s)).length === 0);
      const backup = await evaluate(s, `(JSON.parse(localStorage.getItem('marioKartAutoBackup')||'{}').races||[]).length`);
      t('clear refreshes the auto-backup first (7 races recoverable via Restore)', backup === 7, String(backup));
      const stack = () => evaluate(s, `({ pos: historyPosition, types: actionHistory.map(a => a.type).join(',') })`);
      const beforeUndo = await stack();
      t('the clear is the newest undo entry, on top of the edit', beforeUndo.types === 'EDIT_RACE,CLEAR_DATA' && beforeUndo.pos === 1, JSON.stringify(beforeUndo));
      await evaluate(s, `(()=>{ closeSidebar(); undoLastAction(); return 1 })()`); await sleep(400);
      let stored = await racesIn(s);
      t('undo after clear restores all 7 races, none null', stored.length === 7 && stored.every((r) => r && typeof r === 'object') && stored[2].player1 === 4, JSON.stringify(stored.map((r) => r && r.player1)) + ' stack=' + JSON.stringify(beforeUndo));
      await evaluate(s, `undoLastAction()`); await sleep(300);
      stored = await racesIn(s);
      t('the edit recorded before the clear still undoes against the right row', stored[2].player1 === 3 && stored.every((r) => r && typeof r === 'object'), JSON.stringify(stored.map((r) => r && r.player1)));
      await addViaSidebar(s, { player1: '1', player2: '2', player3: '3' });
      stored = await racesIn(s);
      t('adding after the undo appends to a dense 8-row log', stored.length === 8 && stored.every((r) => r && typeof r === 'object'));
      await goto(s, base + APP + '#stats', { settle: 1800 });
      const after = await evaluate(s, `({ rows: document.querySelectorAll('#history-body tr').length, text: document.getElementById('stats-display').innerText.slice(0,40) })`);
      t('reload after clear+undo+add renders 8 rows and Stats without throwing', after.rows === 8 && errs(s).length === 0, JSON.stringify(after) + ' ' + errs(s).join(' | '));
    } finally { await closePage(cdpPort, s); }
  }

  /* --------------------------------------- modal lifecycle + focus, D8/D16 */
  {
    const s = await open(cdpPort, base, { seed: { marioKartRaces: SEVEN, marioKartPlayerCount: '3' }, hash: '#stats' });
    try {
      for (let i = 0; i < 3; i++) {
        await evaluate(s, `(()=>{ document.querySelector('#history-body .edit-btn').focus(); editRace(0); return 1 })()`); await sleep(150);
        await clickSel(s, '#cancel-edit', { settle: 150 });
      }
      await pressKey(s, 'Escape', 'Escape', 27);
      await pressKey(s, 'Escape', 'Escape', 27);
      t('Escape after three cancelled edit modals throws nothing (listener removed on every close path)', errs(s).length === 0, errs(s).join(' | '));
      const restored = await evaluate(s, `document.activeElement && document.activeElement.classList.contains('edit-btn')`);
      t('focus returns to the edit button that opened the modal', restored, await evaluate(s, `document.activeElement.tagName + '.' + document.activeElement.className`));

      await evaluate(s, `editRace(0)`); await sleep(200);
      const inside = await evaluate(s, `document.querySelector('.modal-dialog').contains(document.activeElement) && document.activeElement.id === 'edit-date'`);
      t('edit modal: initial focus lands on the date field', inside);
      let trapped = true;
      for (let i = 0; i < 12; i++) {
        await pressKey(s, 'Tab', 'Tab', 9);
        if (!(await evaluate(s, `document.querySelector('.modal-dialog').contains(document.activeElement)`))) { trapped = false; break; }
      }
      t('edit modal: Tab cycles inside the dialog (12 presses never leave it)', trapped);
      await pressKey(s, 'Tab', 'Tab', 9, 8);
      const shiftOk = await evaluate(s, `document.querySelector('.modal-dialog').contains(document.activeElement)`);
      t('edit modal: Shift+Tab stays inside too', shiftOk);
      await pressKey(s, 'Escape', 'Escape', 27);
      t('Escape closes the edit modal', await evaluate(s, `!document.querySelector('.modal-overlay')`));
      await evaluate(s, `deleteRace(0)`); await sleep(200);
      const del = await evaluate(s, `(()=>{ const d=document.querySelector('.modal-dialog'); return d.getAttribute('role')==='dialog' && document.activeElement.id==='cancel-delete-race' })()`);
      t('delete modal: dialog role, focus on Cancel (safe default)', del);
      await clickSel(s, '#cancel-delete-race', { settle: 200 });
      await evaluate(s, `editRace(0)`); await sleep(200);
      await axe(s, 'edit modal open');
      await pressKey(s, 'Escape', 'Escape', 27);
    } finally { await closePage(cdpPort, s); }
  }

  /* ------------------------------------------------ sort indicator, D11 */
  {
    const s = await open(cdpPort, base, { seed: { marioKartRaces: SEVEN, marioKartPlayerCount: '3' }, hash: '#stats' });
    try {
      const dates = () => evaluate(s, `[...document.querySelectorAll('#history-body tr td:nth-child(2)')].map(td => td.textContent.trim().slice(0, 12))`);
      const before = await dates();
      t('history default order is chronological, newest first', before[0].startsWith('Aug 16') && before[6].startsWith('Aug 10'), before.join(','));
      await clickSel(s, 'th[data-sort="date"]', { settle: 400 });
      const head = await evaluate(s, `(()=>{ const th=document.querySelector('th[data-sort="date"]'); return { sort: th.getAttribute('aria-sort'), glyph: th.querySelector('.sort-indicator').textContent, focused: document.activeElement === th } })()`);
      const after = await dates();
      t('first click on Date: aria-sort ascending, up arrow, rows oldest first, header keeps focus', head.sort === 'ascending' && head.glyph === '↑' && after[0].startsWith('Aug 10') && head.focused, JSON.stringify(head) + ' ' + after.join(','));
      await clickSel(s, 'th[data-sort="player1"]', { settle: 400 });
      const p1 = await evaluate(s, `[...document.querySelectorAll('#history-body tr td:nth-child(3)')].map(td => td.textContent.trim())`);
      t('first click on a player column sorts positions ascending (1s first)', p1[0] === '1' && p1[p1.length - 1] === '3', p1.join(','));
      await axe(s, 'history with data');
    } finally { await closePage(cdpPort, s); }
  }

  /* ------------------------------------------------- player count, D2 */
  {
    const four = SEVEN.map((r, i) => ({ ...r, player4: 4 }));
    const s = await open(cdpPort, base, { seed: { marioKartRaces: four, marioKartPlayerCount: '4', marioKartPlayerNames: { player1: 'Alice', player2: 'Bob', player3: 'Cara', player4: 'Dan' } }, hash: '#stats' });
    try {
      await openRaceForm(s);
      await evaluate(s, `openSidebarPlayerSettings()`); await sleep(300);
      await clickSel(s, '.player-count-btn[data-count="2"]', { settle: 500 });
      const r = await evaluate(s, `({ inputs: document.querySelectorAll('#sidebar-race-inputs input[type="number"]').length, count: localStorage.getItem('marioKartPlayerCount'), toast: [...document.querySelectorAll('.mk-toast')].map(d=>d.textContent).join('|'), cols: document.querySelectorAll('#history-table thead th').length })`);
      t('count 4 -> 2 by coordinate click: two inputs, count stored, toast shown, no error', r.inputs === 2 && r.count === '2' && /Updated to 2 players/.test(r.toast) && errs(s).length === 0, JSON.stringify(r) + ' ' + errs(s).join(' | '));
      t('removed players keep their recorded results (history still 4 player columns)', r.cols === 7, String(r.cols));
      await clickSel(s, '.player-count-btn[data-count="3"]', { settle: 400 });
      const again = await evaluate(s, `document.querySelectorAll('#sidebar-race-inputs input[type="number"]').length`);
      t('count 2 -> 3 widens the form again', again === 3 && errs(s).length === 0);
      await axe(s, 'sidebar open with Manage Players');
    } finally { await closePage(cdpPort, s); }
  }

  /* -------------------------------------------- per-version names, D10/D15 */
  {
    const s = await open(cdpPort, base, { seed: { marioKartRaces: SEVEN, marioKartPlayerCount: '4', marioKartPlayerNames: { player1: 'Alice', player2: 'Bob', player3: 'Cara', player4: 'Dan' } }, hash: '#stats' });
    try {
      await openRaceForm(s);
      await evaluate(s, `(()=>{ document.getElementById('sidebar-player1').value='5'; return 1 })()`);
      await evaluate(s, `switchGameVersion('mkworld')`); await sleep(600);
      const form = await evaluate(s, `({ v: document.getElementById('sidebar-player1').value, max: document.getElementById('sidebar-player1').max, name: document.querySelector('label[for="sidebar-player1"]').textContent.trim(), grid: document.querySelectorAll('#picker-player1 .position-btn').length })`);
      t('switching to MK World with the form open clears it, max 24, 24 grid buttons', form.v === '' && form.max === '24' && form.grid === 24, JSON.stringify(form));
      t('MK World inherits the MK8D names the first time (read-only fallback)', form.name === 'Alice', form.name);
      await evaluate(s, `PlayerNameManager.set('player1', 'Zed')`); await sleep(200);
      const keys = await evaluate(s, `({ world: JSON.parse(localStorage.getItem('marioKartWorldPlayerNames')||'{}').player1, base: JSON.parse(localStorage.getItem('marioKartPlayerNames')||'{}').player1 })`);
      t('renaming in MK World writes the World key and leaves MK8D alone', keys.world === 'Zed' && keys.base === 'Alice', JSON.stringify(keys));
      await evaluate(s, `switchGameVersion('mk8d')`); await sleep(600);
      const back = await evaluate(s, `({ name: PlayerNameManager.get('player1'), count: getPlayerCount(), cols: document.querySelectorAll('#history-table thead th').length })`);
      t('back on MK8D the names and count are its own again', back.name === 'Alice' && back.count === 4, JSON.stringify(back));
      t('no console errors through the version switches', errs(s).length === 0, errs(s).join(' | '));
    } finally { await closePage(cdpPort, s); }
  }

  /* ------------------------------------------------------- two tabs, D4 */
  {
    const a = await open(cdpPort, base, { seed: { marioKartRaces: SEVEN.slice(0, 2), marioKartPlayerCount: '3' }, hash: '#stats' });
    const b = await newPage(cdpPort);
    try {
      await setViewport(b, 1280, 900);
      await goto(b, base + APP + '#stats', { settle: 1800 });
      b.errors.length = 0;
      const addA = await addViaSidebar(a, { player1: '1', player2: '2', player3: '3' });
      t('the add in tab A succeeded', addA.mem === 3 && !addA.error, JSON.stringify(addA));
      await sleep(600);
      const bState = await evaluate(b, `({ rows: document.querySelectorAll('#history-body tr').length, mem: races.length, stored: JSON.parse(localStorage.getItem('marioKartRaces')||'[]').length, view: currentView })`);
      t('tab B renders the race tab A added', bState.rows === 3 && bState.mem === 3, JSON.stringify(bState) + ' Berrs=' + errs(b).join('|'));
      const addB = await addViaSidebar(b, { player1: '2', player2: '1', player3: '3' });
      t('the add in tab B succeeded', addB.mem === 4 && !addB.error, JSON.stringify(addB));
      await sleep(600);
      const stored = await racesIn(a);
      const aRows = await evaluate(a, `document.querySelectorAll('#history-body tr').length`);
      const bMem = await evaluate(b, `races.length`);
      t('after adds in A then B storage holds all 4 and A renders 4', stored.length === 4 && aRows === 4, `stored=${stored.length} Arows=${aRows} Bmem=${bMem}`);
      await evaluate(b, `performDeleteRace(0)`); await sleep(600);
      const aAfterDelete = await evaluate(a, `({ rows: document.querySelectorAll('#history-body tr').length, mem: races.length })`);
      t('a delete in B reaches A (rows and memory both 3)', aAfterDelete.rows === 3 && aAfterDelete.mem === 3, JSON.stringify(aAfterDelete));
      await addViaSidebar(a, { player1: '3', player2: '2', player3: '1' });
      const final = await racesIn(a);
      t('A\'s next add does not resurrect the deleted race (4 rows, not 5)', final.length === 4, String(final.length));
      const undoState = await evaluate(a, `document.getElementById('sidebar-undo-btn').disabled`);
      t('A\'s undo button is live only for its own newest action', undoState === false);
      await evaluate(a, `undoLastAction()`); await sleep(500);
      t('undo in A after a foreign change only removes A\'s own add (3 rows)', (await racesIn(a)).length === 3);
      t('no console errors in either tab', errs(a).length === 0 && errs(b).length === 0, [...errs(a), ...errs(b)].join(' | '));
    } finally { await closePage(cdpPort, a); await closePage(cdpPort, b); }
  }

  /* --------------------------------------------------- phone geometry */
  for (const width of [360, 390, 412]) {
    const s = await open(cdpPort, base, { seed: { marioKartRaces: SEVEN, marioKartPlayerCount: '3' }, viewport: [width, 844, true], hash: '#stats' });
    try {
      await openRaceForm(s);
      await clickSel(s, '.position-picker-toggle', { settle: 400 });
      const grid = await evaluate(s, `(()=>{ const p=document.getElementById('picker-player1'); const pr=p.getBoundingClientRect();
        const btns=[...p.querySelectorAll('.position-btn')].map(b=>b.getBoundingClientRect());
        const over=btns.filter(b=>b.right>pr.right+0.5||b.left<pr.left-0.5).length;
        const four=p.querySelector('[data-position="4"]').getBoundingClientRect();
        const hit=document.elementsFromPoint(four.left+four.width/2, four.top+four.height/2)[0];
        return { over, n: btns.length, x: four.left+four.width/2, y: four.top+four.height/2, hitOk: hit && hit.dataset.position==='4', pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth } })()`);
      t(`${width}px: every position button sits inside the picker and the page does not overflow`, grid.over === 0 && grid.n === 12 && !grid.pageOverflow, JSON.stringify(grid));
      await clickAt(s, grid.x, grid.y); await sleep(300);
      const val = await evaluate(s, `document.getElementById('sidebar-player1').value`);
      t(`${width}px: tapping position 4 by coordinates sets the input`, grid.hitOk && val === '4', `hit=${grid.hitOk} value=${val}`);
      await evaluate(s, `closeSidebar()`); await sleep(300);
      if (width === 390) {
        const sizes = await evaluate(s, `(()=>{ openSidebar(); const r=(sel)=>{const e=document.querySelector(sel); const b=e.getBoundingClientRect(); return [Math.round(b.width), Math.round(b.height)]}; const out={ close: r('.sidebar-close-btn'), clear: r('#sidebar-clear-btn') }; closeSidebar(); out.page = r('.pagination-btn'); return out })()`);
        t('390px: sidebar close/trash and pagination buttons are at least 40px', [sizes.close, sizes.clear, sizes.page].every(([w, h]) => w >= 40 && h >= 40), JSON.stringify(sizes));
        await view(s, 'h2h'); await sleep(300);
        const h2h = await evaluate(s, `(()=>{ const c=document.querySelector('.h2h-table-container'); const tbl=document.querySelector('.h2h-table'); return { scroll: c.scrollWidth > c.clientWidth + 1, cards: getComputedStyle(tbl.querySelector('tbody tr')).display, labels: [...tbl.querySelectorAll('td.h2h-cell:not(.h2h-self)')].every(td => getComputedStyle(td,'::before').content.includes('vs')), page: document.documentElement.scrollWidth > document.documentElement.clientWidth } })()`);
        t('390px: H2H renders as stacked cards with "vs Name" labels, no sideways scroll', !h2h.scroll && h2h.cards === 'block' && h2h.labels && !h2h.page, JSON.stringify(h2h));
        await screenshot(s, path.join(REPO, '.screenshots', 'audit', 'mario-kart', 'e2e-390-h2h-cards.png')).catch(() => {});
        await axe(s, 'H2H at 390');
        await view(s, 'stats'); await sleep(300);
        await evaluate(s, `(()=>{ document.querySelector('.pagination-container').scrollIntoView({block:'center'}); return 1 })()`);
        await evaluate(s, `(()=>{ window.scrollTo(0, 0); return 1 })()`); await sleep(200);
        const overlap = await evalAsync(s, `(()=>{ const btn=document.querySelector('.pagination-btn:not(:disabled)');
          const target=btn.getBoundingClientRect().top + window.scrollY - 140;
          const step=(y)=>new Promise(r=>{ window.scrollTo(0, y); setTimeout(r, 160) });
          return step(target/2).then(()=>step(target)).then(()=>new Promise(r=>setTimeout(()=>{
            const b=btn.getBoundingClientRect();
            const top=document.elementsFromPoint(b.left+b.width/2, b.top+b.height/2)[0];
            r({ y: Math.round(window.scrollY), visible: b.top > 0 && b.bottom < window.innerHeight,
                top: !!(top && (top===btn || btn.contains(top))),
                cover: top ? (top.tagName + '.' + String(top.className).slice(0, 40)) : 'none',
                hidden: document.getElementById('sidebar-toggle').classList.contains('scrolled-away') });
          }, 350))) })()`);
        t('390px: after scrolling down, the sidebar toggle is out of the way of the pagination button', overlap.hidden && overlap.top && overlap.visible, JSON.stringify(overlap));
        await evaluate(s, `(()=>{ window.scrollTo(0, 0); return 1 })()`); await sleep(400);
        const backTop = await evaluate(s, `!document.getElementById('sidebar-toggle').classList.contains('scrolled-away')`);
        t('390px: scrolling back up brings the toggle back', backTop);
      }
      t(`${width}px: no console errors`, errs(s).length === 0, errs(s).join(' | '));
    } finally { await closePage(cdpPort, s); }
  }

  /* ----------------------------------------------------- restore, D5 */
  {
    const s = await open(cdpPort, base, { seed: { marioKartRaces: SEVEN, marioKartPlayerCount: '3', marioKartAutoBackup: { races: [{ date: '2026-08-01', timestamp: '24:10:00 CDT', player1: 5, player2: 5, player3: 99, player4: null }], backupDate: '2026-08-22T10:00:00Z', version: '2.2' } }, hash: '#stats' });
    try {
      await evaluate(s, `restoreFromBackup()`); await sleep(300);
      const r = await evaluate(s, `({ modal: !!document.querySelector('.modal-overlay'), toast: [...document.querySelectorAll('.mk-toast')].map(d=>d.textContent).join('|'), rows: document.querySelectorAll('#history-body tr').length })`);
      t('a tampered backup is refused with a plain message and no confirm modal; the log is untouched', !r.modal && /Backup cannot be restored: race #1/.test(r.toast) && r.rows === 7, JSON.stringify(r));
      const toast = await evaluate(s, `(()=>{ const e=document.querySelector('.mk-toast'); const b=e.getBoundingClientRect(); const h=document.querySelector('.header-section h1').getBoundingClientRect(); return { belowTitle: b.top > h.bottom, role: e.getAttribute('role') } })()`);
      t('toasts sit at the bottom, not over the page title, and announce as status', toast.belowTitle && toast.role === 'status', JSON.stringify(toast));
    } finally { await closePage(cdpPort, s); }
  }

  /* ------------------------------------------------ tablist keyboard */
  {
    const s = await open(cdpPort, base, { seed: { marioKartRaces: SEVEN, marioKartPlayerCount: '3' }, hash: '#stats' });
    try {
      await evaluate(s, `(()=>{ document.querySelector('.toggle-btn[aria-selected="true"]').focus(); return 1 })()`);
      await pressKey(s, 'ArrowRight', 'ArrowRight', 39);
      await sleep(300);
      const r = await evaluate(s, `({ view: currentView, focused: document.activeElement.getAttribute('role') === 'tab' && document.activeElement.getAttribute('aria-selected') === 'true' })`);
      t('ArrowRight on the tablist moves to and activates the next tab', r.view === 'h2h' && r.focused, JSON.stringify(r));
      await pressKey(s, 'Home', 'Home', 36); await sleep(300);
      t('Home jumps to the first tab', (await evaluate(s, `currentView`)) === 'help');
      const label = await evaluate(s, `(()=>{ const l=document.querySelector('label.player-name-label'); return { role: l.getAttribute('role'), tab: l.getAttribute('tabindex') } })()`);
      t('player labels no longer claim to be buttons', label.role === null && label.tab === null, JSON.stringify(label));
    } finally { await closePage(cdpPort, s); }
  }

  return R;
}
