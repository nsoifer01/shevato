// MapTap Rivals browser regressions for the 2026-08-22 site-wide audit.
//
// Same shape as apps/fpl-planner/e2e/*.mjs: raw CDP through tests/browser/cdp.mjs,
// real coordinate clicks and key events, seeded localStorage, a screenshot only
// when a check fails. Every block names the audit defect it pins (D1..D18);
// the unit-level halves live in tests/app-helpers.test.js and tests/stats.test.js.
//
// Fixtures the browser reads (backup JSON, WhatsApp exports) are written under
// the repo's gitignored .screenshots/ at run time: the snap Chromium cannot read
// /tmp, and DOM.setFileInputFiles does not fire `change` here, so the suite
// dispatches it (see FINDINGS "Verifying the dashboard in headless Chrome").
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  newPage, closePage, goto, evaluate, evalAsync, waitForExpr, clickSel, clickAt,
  setViewport, screenshot, pressKey, seedAndReload, sleep, cleanErrors,
} from '../../../tests/browser/cdp.mjs';

const APP = '/apps/maptap-rivals/index.html';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const ART_DIR = path.join(REPO, '.screenshots', 'e2e-maptap-rivals');
const FILES = path.join(ART_DIR, 'files');
const AXE_PATH = path.join(REPO, 'tests', 'browser', 'vendor', 'axe.min.js');

const READY = "!!document.querySelector('#dash-summary .dash-summary-card, #paste-actions, #dash-empty:not([hidden])')";

/* ------------------------------------------------------------ fixtures */

const rival = (id, name, extra = {}) => ({ id, name, color: '#e74c3c', icon: '🦊', createdAt: 1700000000000, maptapUsername: '', ...extra });
const W = [1, 1, 2, 3, 3];
const tot = (a) => a.reduce((s, v, i) => s + v * W[i], 0);
const game = (rivalId, date, my, their, extra = {}) => ({
  id: 'g' + rivalId + date, rivalId, date, note: '', myScores: my, theirScores: their,
  myScore: tot(my), theirScore: tot(their), createdAt: 1700000000000, ...extra,
});
const sc = (seed) => [0, 1, 2, 3, 4].map(i => ((seed * 37 + i * 53) % 90) + 5);

// Dates relative to the machine's local today, so "this week" and the
// heatmap window stay meaningful on any run date.
function localISO(d) { const tz = d.getTimezoneOffset() * 60000; return new Date(d - tz).toISOString().slice(0, 10); }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return localISO(d); }
const TODAY = daysAgo(0);

function bigSeed() {
  const rivals = [rival('r1', 'Bob'), rival('r2', 'Carol', { icon: '🐻' }), rival('r3', 'Dave (no games)', { icon: '🐙' })];
  const games = [];
  for (let i = 0; i < 400; i++) { if (i % 7 === 3) continue; games.push(game('r1', daysAgo(i), sc(i), sc(i + 11))); }
  games.push(game('r2', daysAgo(1), [60, 60, 60, 60, 60], [61, 61, 61, 61, 61]));
  games.push({ id: 'legacy1', rivalId: 'r2', date: daysAgo(30), note: '', myScore: 700, theirScore: 650, createdAt: 1 });
  games.push({ id: 'dnpme', rivalId: 'r2', date: daysAgo(2), note: 'synced from MapTap', theirScores: [90, 90, 90, 90, 90], theirScore: 900, createdAt: 1 });
  games.push(game('r2', TODAY, [55, 65, 75, 85, 95], [95, 85, 75, 65, 55]));
  return { rivals, games };
}

const JUNK_BACKUP = '{"rivals":[null,1,{"id":"q"},{"id":"q2","name":"Dup"}],"games":[null,{},{"rivalId":"q","date":"2026-08-01","myScores":[1,2,3,4,5],"theirScores":[1,2,3,4,5]}],"me":{"evil":1}}';
const VALID_BACKUP = JSON.stringify({ version: 1, me: 'Imported', myIcon: '🐸', rivals: [rival('x1', 'Zed')], games: [game('x1', '2026-08-01', [1, 2, 3, 4, 5], [5, 4, 3, 2, 1])] });
const WA_IOS = '[20/08/2026, 21:05:10] Bob: MapTap #400\nAug 20\n95 89 91 9 64\nFinal score: 585\nmaptap.gg\n[20/08/2026, 21:07:00] Nik: MapTap #400\nAug 20\n90 80 91 9 64\nFinal score: 585\nmaptap.gg\n';

async function writeFixtures() {
  await mkdir(FILES, { recursive: true });
  await writeFile(path.join(FILES, 'junk.json'), JUNK_BACKUP);
  await writeFile(path.join(FILES, 'valid.json'), VALID_BACKUP);
  await writeFile(path.join(FILES, 'not-json.json'), 'hello');
  await writeFile(path.join(FILES, 'wa-ios.txt'), WA_IOS);
}

/* ------------------------------------------------------------- drivers */

function recorder(R) {
  return async (name, pass, detail = '', s = null) => {
    R.push({ name, pass: !!pass, detail: detail ? String(detail).slice(0, 220) : '' });
    // E2E_TRACE=1 streams each check as it lands, which is how a hang inside a
    // block gets located (a throw discards the whole result array otherwise).
    if (process.env.E2E_TRACE) console.log(`    ${pass ? 'ok' : 'FAIL'} ${name}`);
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

// Native alert/confirm auto-answer; messages are kept for assertions.
function dialogs(s, accept = true) {
  s.dialogLog = [];
  s.on(async (m, p) => {
    if (m === 'Page.javascriptDialogOpening') {
      s.dialogLog.push(p.message);
      try { await s.send('Page.handleJavaScriptDialog', { accept: typeof accept === 'function' ? accept(p.message) : accept }); } catch { /* closed */ }
    }
  });
}

async function openSeeded(cdpPort, base, seed, { width = 1280, height = 900, mobile = false, hash = '' } = {}) {
  const s = await newPage(cdpPort);
  dialogs(s);
  await setViewport(s, width, height, mobile);
  // Every page in this run shares one origin, so a previous block's seed is
  // still in localStorage: wipe the app's keys before seeding this one.
  await goto(s, base + APP, { settle: 600 });
  await evaluate(s, "(()=>{for(const k of Object.keys(localStorage)) if(/^maptapRivals/.test(k)) localStorage.removeItem(k); return 1})()");
  const kv = {};
  for (const [k, v] of Object.entries(seed)) kv[k] = typeof v === 'string' ? v : JSON.stringify(v);
  await seedAndReload(s, base + APP, kv);
  await waitForExpr(s, READY, { timeout: 10000 });
  if (hash) { await goto(s, base + APP + hash, { settle: 900 }); }
  return s;
}

// clickSel reads the rect in the same evaluate as scrollIntoView; on this
// page the scroll has not landed by then for anything below the fold (the
// site chrome scrolls a wrapper), so the click misses. Scroll, settle, then
// click with fresh coordinates.
async function click(s, sel, { nth = 0, settle = 500 } = {}) {
  // scrollIntoView is a no-op on this page (the site chrome sizes <html> to
  // the viewport), so scroll the window to the element's own offset instead
  // and let clickSel re-read the rect afterwards.
  await evaluate(s, `(()=>{const e=[...document.querySelectorAll(${JSON.stringify(sel)})][${nth}]; if(!e) return false;
    const r=e.getBoundingClientRect(); window.scrollTo(0, Math.max(0, r.top + window.scrollY - window.innerHeight/2)); return true})()`);
  await sleep(300);
  return clickSel(s, sel, { nth, settle });
}

// The paste panel is a collapsed <details>. Chromium reports stale geometry
// for content inside a closed one (content-visibility: hidden), so a
// coordinate click lands on whatever is painted there - open it first, the
// way a user does, before typing into it.
async function openPastePanel(s) {
  await click(s, '.paste-collapse-summary');
  await waitForExpr(s, "document.querySelector('.paste-collapse').open === true", { timeout: 3000 });
  await sleep(200);
}

// Fills my paste box and the first rival's, both through real input events.
async function fillPaste(s, mine = '95 89 91 9 64', theirs = '90 80 91 9 64') {
  await evaluate(s, `(()=>{const i=document.querySelector('#paste-mine-input');i.value=${JSON.stringify(mine)};i.dispatchEvent(new Event('input',{bubbles:true}));
    const r=document.querySelector('.paste-rival-textarea');r.value=${JSON.stringify(theirs)};r.dispatchEvent(new Event('input',{bubbles:true}));return 1})()`);
  await sleep(250);
}

const ls = (s, key) => evaluate(s, `localStorage.getItem(${JSON.stringify(key)})`);
const txt = (s, sel) => evaluate(s, `(()=>{const e=document.querySelector(${JSON.stringify(sel)});return e?e.textContent.replace(/\\s+/g,' ').trim():null})()`);
const viewText = (s, sel) => evaluate(s, `(()=>{const e=document.querySelector(${JSON.stringify(sel)});return e?e.innerText:''})()`);

async function setFile(s, inputSel, filePath) {
  const { root } = await s.send('DOM.getDocument', { depth: 1 });
  const { nodeId } = await s.send('DOM.querySelector', { nodeId: root.nodeId, selector: inputSel });
  await s.send('DOM.setFileInputFiles', { nodeId, files: [filePath] });
  await evaluate(s, `(()=>{const i=document.querySelector(${JSON.stringify(inputSel)});i.dispatchEvent(new Event('change',{bubbles:true}));return i.files.length})()`);
  await sleep(900);
}

async function axeViolations(s, axeSource) {
  await s.send('Runtime.evaluate', { expression: axeSource, returnByValue: false });
  const v = await evalAsync(s, `window.axe.run(document.querySelector('.maptap-rivals, main, body'), {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] }, resultTypes: ['violations'],
  }).then(r => r.violations.filter(x => x.impact === 'serious' || x.impact === 'critical')
    .map(x => x.id + '[' + x.impact + ']x' + x.nodes.length + '@' + (x.nodes[0].target || []).join(' ')))`);
  return Array.isArray(v) ? v : [`axe failed: ${JSON.stringify(v)}`];
}

/* ------------------------------------------------------------------ run */

export async function run({ base, cdpPort }) {
  const R = [];
  const rec = recorder(R);
  await writeFixtures();
  const axeSource = await readFile(AXE_PATH, 'utf8');
  const seed = bigSeed();

  /* ---------------------------------------------- D1: backup import */
  {
    const s = await openSeeded(cdpPort, base, { maptapRivalsRivals: seed.rivals.slice(0, 1), maptapRivalsGames: seed.games.slice(0, 3) });
    try {
      const before = await ls(s, 'maptapRivalsGames');
      await setFile(s, '#import-file', path.join(FILES, 'junk.json'));
      const after = await ls(s, 'maptapRivalsGames');
      const rivalsAfter = JSON.parse(await ls(s, 'maptapRivalsRivals'));
      const msg = s.dialogLog.join(' || ');
      await rec('D1: a junk backup is validated before anything is persisted (confirm names the skipped count)',
        /will be skipped/.test(msg) && /1 rivals and 1 games/.test(msg), msg, s);
      await rec('D1: the import result is honest: "Imported ... skipped N invalid entries (reasons)"',
        /Imported 1 rival, 1 game\. Skipped 5 invalid entr/.test(msg) && !/Could not parse/.test(msg), msg, s);
      await rec('D1: storage holds only the readable entries (no null / number rivals)',
        rivalsAfter.length === 1 && rivalsAfter[0].name === 'Dup' && JSON.parse(after).length === 1, JSON.stringify(rivalsAfter), s);
      await rec('D1: the dashboard still renders after the import', await waitForExpr(s, READY, { timeout: 4000 }), '', s);
      const errs = cleanErrors(s);
      await rec('D1: no console errors after importing junk', errs.length === 0, errs.join(' | '), s);

      s.dialogLog.length = 0;
      await setFile(s, '#import-file', path.join(FILES, 'not-json.json'));
      await rec('D1: a non-JSON file is rejected with the right message and leaves storage alone',
        /not valid JSON/.test(s.dialogLog.join(' ')) && (await ls(s, 'maptapRivalsRivals')) === JSON.stringify(rivalsAfter), s.dialogLog.join(' '), s);

      s.dialogLog.length = 0;
      await setFile(s, '#import-file', path.join(FILES, 'valid.json'));
      const rivalsValid = JSON.parse(await ls(s, 'maptapRivalsRivals'));
      await rec('D1: a valid backup imports and reports "Imported 1 rival, 1 game."',
        /Imported 1 rival, 1 game\.$/.test(s.dialogLog[s.dialogLog.length - 1] || '') && rivalsValid[0].name === 'Zed'
        && (await evaluate(s, "document.querySelector('#my-name').value")) === 'Imported', s.dialogLog.join(' || '), s);
      await goto(s, base + APP, { settle: 1500 });
      await rec('D1: the app reloads cleanly on the imported data',
        await waitForExpr(s, "document.querySelectorAll('.rival-card').length===1", { timeout: 6000 }), '', s);
      void before;
    } finally { await closePage(cdpPort, s); }
  }

  /* ------------------------------------- D16: corrupted stored arrays */
  {
    const s = await openSeeded(cdpPort, base, { maptapRivalsRivals: [seed.rivals[0], null, 'str', 5], maptapRivalsGames: '{"a":1}' });
    try {
      await rec('D16: an object-shaped game log and junk rival entries render the dashboard instead of crashing',
        (await evaluate(s, "document.querySelectorAll('.rival-card').length")) === 1, '', s);
      await goto(s, base + APP, { settle: 250 });
      await rec('D16: the user is told what was skipped',
        await waitForExpr(s, "/Skipped 3 unreadable/.test((document.querySelector('.share-toast')||{}).textContent||'')", { timeout: 3000, poll: 80 }), await txt(s, '.share-toast'), s);
      for (const v of ['leaderboard', 'matrix', 'records', 'history']) {
        await goto(s, base + APP + '#' + v, { settle: 500 });
      }
      const errs = cleanErrors(s);
      await rec('D16: every view renders on corrupted storage without console errors', errs.length === 0, errs.join(' | '), s);
    } finally { await closePage(cdpPort, s); }
  }

  /* --------------------------------------------- D2: orphaned games */
  {
    const two = { rivals: seed.rivals.slice(0, 2), games: [
      game('r1', daysAgo(1), [50, 50, 50, 50, 50], [40, 40, 40, 40, 40]),
      game('r2', daysAgo(1), [50, 50, 50, 50, 50], [60, 60, 60, 60, 60]),
      game('ghost', TODAY, [99, 99, 99, 99, 99], [1, 1, 1, 1, 1]),
      game('ghost', daysAgo(1), [99, 99, 99, 99, 99], [1, 1, 1, 1, 1]),
    ] };
    const s = await openSeeded(cdpPort, base, { maptapRivalsRivals: two.rivals, maptapRivalsGames: two.games });
    try {
      const summary = await txt(s, '#dash-summary');
      await rec('D2: the dashboard summary counts only games whose rival exists (1W 1L over 2 games, 0 today)',
        /1W · 1L · 0T/.test(summary) && /over 2 games/.test(summary) && /Today ?0/.test(summary), summary, s);
      await goto(s, base + APP + '#history', { settle: 600 });
      const notice = await txt(s, '#history-orphans');
      await rec('D2: History shows a "games without a rival" notice with Reassign and Delete',
        /2 games without a rival/.test(notice) && !!(await evaluate(s, "!!document.querySelector('#history-orphans-reassign') && !!document.querySelector('#history-orphans-delete')")), notice, s);
      await rec('D2: History rows exclude the ghost games',
        (await evaluate(s, "document.querySelectorAll('#history-table tbody tr.history-day-row').length")) === 2
        && /of 2$/.test(await txt(s, '#history-pagination-meta')), await txt(s, '#history-pagination-meta'), s);
      await evaluate(s, "(()=>{const sel=document.querySelector('#history-orphans-rival'); sel.value='r1'; sel.dispatchEvent(new Event('change')); return 1})()");
      await click(s, '#history-orphans-reassign');
      const stored = JSON.parse(await ls(s, 'maptapRivalsGames'));
      await rec('D2: Reassign moves the orphans to the chosen rival and persists',
        stored.every(g => g.rivalId !== 'ghost') && stored.filter(g => g.rivalId === 'r1').length === 3
        && !(await evaluate(s, "!!document.querySelector('#history-orphans')"))
        && (await evaluate(s, "document.querySelectorAll('#history-table tbody tr.history-day-row').length")) === 4, JSON.stringify(stored.map(g => g.rivalId)), s);
    } finally { await closePage(cdpPort, s); }
  }

  /* --------------------------------------- D4 / D5 / D6: bad records */
  {
    // r1 carries the malformed-round record (D4), r2 carries enough real
    // games for the heatmap plus one whose date does not parse (D6).
    const games = seed.games.slice(0, 12).concat([
      { id: 'nan1', rivalId: 'r1', date: daysAgo(5), note: '', myScores: [null, 'x', 50, 50, 50], theirScores: [50, 50, 50, 50, 50], myScore: null, theirScore: 500, createdAt: 1 },
      ...[3, 4, 6, 8, 9, 11, 13].map(d => game('r2', daysAgo(d), sc(d), sc(d + 3))),
      game('r2', 'bad-x1', [50, 50, 50, 50, 50], [10, 10, 10, 10, 10]),
    ]);
    const s = await openSeeded(cdpPort, base, {
      maptapRivalsRivals: seed.rivals, maptapRivalsGames: games,
      maptapRivalsMyProfile: { username: 'susmabit', nickname: 'S', verifiedAt: 'x' }, maptapRivalsMyMapTap: '"susmabit"',
    });
    try {
      await rec('D5: a stored profile snapshot without avgScore renders the dashboard (summary cards present)',
        (await evaluate(s, "document.querySelectorAll('#dash-summary .dash-summary-card').length")) >= 3
        && !/undefined/.test(await txt(s, '#profile-card')), await txt(s, '#profile-card'), s);
      const nanDash = /NaN/.test(await viewText(s, '.view-dashboard'));
      await goto(s, base + APP + '#leaderboard', { settle: 500 });
      const nanLb = /NaN/.test(await viewText(s, '.view-leaderboard'));
      await goto(s, base + APP + '#rival/r1', { settle: 700 });
      const nanRival = /NaN/.test(await viewText(s, '.view-rival'));
      await rec('D4: no literal "NaN" on dashboard, leaderboard or rival view with a malformed record present',
        !nanDash && !nanLb && !nanRival, `dash:${nanDash} lb:${nanLb} rival:${nanRival}`, s);
      await goto(s, base + APP + '#rival/r2', { settle: 700 });
      const errs = cleanErrors(s);
      const rivalRender = await evaluate(s, `(()=>({cards:document.querySelectorAll('#rival-stat-cards .stat-card').length, heatmapCells:document.querySelectorAll('#heatmap-grid .heatmap-cell').length, heatmapHidden:document.querySelector('#heatmap-section').hidden}))()`);
      await rec('D6: a rival with an unparseable game date renders stat cards AND the heatmap, no RangeError',
        errs.length === 0 && rivalRender.cards > 0 && !rivalRender.heatmapHidden && rivalRender.heatmapCells > 0,
        `${errs.join(' | ')} ${JSON.stringify(rivalRender)}`, s);
    } finally { await closePage(cdpPort, s); }
  }

  /* ------------------------------------------- D3: signed-out Join */
  {
    const s = await openSeeded(cdpPort, base, { maptapRivalsRivals: seed.rivals.slice(0, 1) });
    try {
      const clicked = await click(s, '.network-join-btn', { settle: 800 });
      // The shared auth modal is position:fixed, so offsetParent is null even
      // when it is on screen: measure it instead.
      const modalShown = await evaluate(s, "(()=>{const m=document.querySelector('#auth-modal'); if(!m) return false; const r=m.getBoundingClientRect(); return getComputedStyle(m).display!=='none' && getComputedStyle(m).visibility!=='hidden' && r.width>0 && r.height>0})()");
      const status = await txt(s, '.network-status-text');
      await rec('D3: signed out, "Join rival network" opens the sign-in modal or shows a sign-in hint',
        clicked && (modalShown || /sign in/i.test(status || '')), `modal:${modalShown} status:${status}`, s);
    } finally { await closePage(cdpPort, s); }
  }

  /* --------------------------- D8 / D9 / D17 / D18: phone geometry */
  {
    const s = await openSeeded(cdpPort, base, { maptapRivalsRivals: seed.rivals, maptapRivalsGames: seed.games }, { width: 390, height: 844, mobile: true });
    try {
      const tabs = await evaluate(s, `(()=>{const t=document.querySelector('.view-tabs');return {scrollable:t.classList.contains('is-scrollable'),end:t.classList.contains('is-scroll-end'),sw:t.scrollWidth,cw:t.clientWidth}})()`);
      await rec('D18: at 390 the tab strip is scrollable and shows its edge fade (is-scrollable, not is-scroll-end)',
        tabs.scrollable && !tabs.end && tabs.sw > tabs.cw, JSON.stringify(tabs), s);
      await evaluate(s, "(()=>{const t=document.querySelector('.view-tabs');t.scrollLeft=t.scrollWidth;return 1})()");
      await sleep(300);
      await rec('D18: scrolled to the end the fade is dropped',
        await evaluate(s, "document.querySelector('.view-tabs').classList.contains('is-scroll-end')"), '', s);

      const targets = await evaluate(s, `(()=>{const r=s=>{const e=document.querySelector(s);if(!e)return null;const b=e.getBoundingClientRect();return [Math.round(b.width),Math.round(b.height)]};return {icon:r('#my-icon-btn'),settings:r('#export-btn'),name:r('#my-name')}})()`);
      await rec('D17: settings-strip targets are at least 36 px tall on a phone',
        targets.icon && targets.icon[1] >= 36 && targets.settings && targets.settings[1] >= 36, JSON.stringify(targets), s);
      await click(s, '#add-rival-btn', { settle: 500 });
      const modalTargets = await evaluate(s, `(()=>{const r=s=>{const e=document.querySelector(s);if(!e)return null;const b=e.getBoundingClientRect();return [Math.round(b.width),Math.round(b.height)]};return {close:r('#rival-modal .modal-close'),color:r('.color-swatch'),icon:r('.icon-swatch')}})()`);
      await rec('D17: modal close and swatches are at least 30 px on a phone',
        modalTargets.close && modalTargets.close[0] >= 36 && modalTargets.color && modalTargets.color[0] >= 30 && modalTargets.icon && modalTargets.icon[0] >= 36, JSON.stringify(modalTargets), s);
      await pressKey(s, 'Escape', 'Escape', 27);

      await goto(s, base + APP + '#matrix/record', { settle: 800 });
      const mx = await evaluate(s, `(()=>{const w=document.querySelector('#matrix-wrap');const cells=[...document.querySelectorAll('.matrix-cell')];const ws=cells.map(c=>c.getBoundingClientRect().width);return {sw:w.scrollWidth,cw:w.clientWidth,min:Math.min(...ws),n:cells.length,tab:w.getAttribute('tabindex'),docOverflow:document.documentElement.scrollWidth>document.documentElement.clientWidth}})()`);
      await rec('D8: at 390 the matrix keeps cells >= 80 px wide and scrolls inside its wrap (no page overflow)',
        mx.n > 0 && mx.min >= 80 && mx.sw > mx.cw && !mx.docOverflow && mx.tab === '0', JSON.stringify(mx), s);

      await goto(s, base + APP + '#rival/r1', { settle: 1200 });
      const hm = await evaluate(s, `(()=>{const g=document.querySelector('#heatmap-grid');const cells=[...g.querySelectorAll('.heatmap-cell:not(.heatmap-empty)')];const cols=(g.style.gridTemplateColumns.match(/repeat\\((\\d+)/)||[])[1];const w=cells.length?cells[0].getBoundingClientRect().width:0;return {cols:Number(cols),w:Math.round(w*10)/10,n:cells.length,labels:document.querySelectorAll('.heatmap-month-lbl').length}})()`);
      await rec('D9: at 390 the heatmap shows at most 26 weeks with cells >= 10 px',
        hm.cols > 0 && hm.cols <= 26 && hm.w >= 10, JSON.stringify(hm), s);
      const cellBox = await evaluate(s, `(()=>{const c=[...document.querySelectorAll('#heatmap-grid .heatmap-W, #heatmap-grid .heatmap-L')].pop();if(!c)return null;c.scrollIntoView({block:'center'});const b=c.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2,title:c.title}})()`);
      if (cellBox) await clickAt(s, cellBox.x, cellBox.y);
      await sleep(300);
      const tip = await txt(s, '#heatmap-tap-tip');
      await rec('D9: tapping a heatmap cell writes its day tooltip into a live region',
        !!cellBox && tip === cellBox.title, `tip:${tip} title:${cellBox && cellBox.title}`, s);
      const overflow = await evaluate(s, 'document.documentElement.scrollWidth>document.documentElement.clientWidth');
      await rec('D9: the rival view has no horizontal page overflow at 390', !overflow, '', s);
    } finally { await closePage(cdpPort, s); }
  }

  /* -------------------------------------- D10: seeded axe scans */
  for (const [label, width, height, mobile] of [['1280', 1280, 900, false], ['390', 390, 844, true]]) {
    const s = await openSeeded(cdpPort, base, { maptapRivalsRivals: seed.rivals, maptapRivalsGames: seed.games }, { width, height, mobile });
    try {
      for (const [view, hash] of [['dashboard', ''], ['rival view', '#rival/r1'], ['leaderboard', '#leaderboard'], ['matrix', '#matrix/record'], ['records', '#records'], ['history', '#history']]) {
        if (hash) await goto(s, base + APP + hash, { settle: 900 });
        const v = await axeViolations(s, axeSource);
        await rec(`D10: axe (wcag2a+aa) seeded ${view} at ${label}: zero serious/critical`, v.length === 0, v.join(' ; '), s);
      }
    } finally { await closePage(cdpPort, s); }
  }

  /* ----------------------------- D11 / D12 / D13 / D14: keyboard, hints */
  {
    const s = await openSeeded(cdpPort, base, { maptapRivalsRivals: seed.rivals.slice(0, 2), maptapRivalsMe: '"Nik"' });
    try {
      // D12: keyboard focus on a view tab must be visible.
      await evaluate(s, "(()=>{document.querySelector('#my-name').focus();return 1})()");
      await clickSel(s, '.view-tab[data-view="history"]', { settle: 200 });
      await evaluate(s, "(()=>{document.querySelector('.view-tab[data-view=\"rival\"]').focus();return 1})()");
      await pressKey(s, 'Tab', 'Tab', 9);
      const ring = await evaluate(s, `(()=>{const e=document.activeElement;if(!e||!e.classList.contains('view-tab'))return {el:e&&e.tagName};const c=getComputedStyle(e);return {el:'tab',style:c.outlineStyle,width:c.outlineWidth,color:c.outlineColor,matches:e.matches(':focus-visible')}})()`);
      await rec('D12: a keyboard-focused view tab shows a visible accent outline (not the UA 1px near-black ring)',
        ring.el === 'tab' && ring.matches && ring.style !== 'none' && parseFloat(ring.width) >= 2 && ring.color !== 'rgb(16, 16, 16)', JSON.stringify(ring), s);

      // D11: rival modal traps Tab and restores focus to its opener.
      await clickSel(s, '.view-tab[data-view="dashboard"]', { settle: 300 });
      await evaluate(s, "(()=>{document.querySelector('#add-rival-btn').focus();return 1})()");
      await pressKey(s, 'Enter', 'Enter', 13, 0, '\r');
      await sleep(300);
      await evaluate(s, "(()=>{document.querySelector('#rival-save-btn').focus();return 1})()");
      await pressKey(s, 'Tab', 'Tab', 9);
      const afterSave = await evaluate(s, "(()=>{const a=document.activeElement;return {inModal:!!a.closest('#rival-modal'),id:a.id||a.className}})()");
      await rec('D11: Tab after the modal\'s last control stays inside the rival modal', afterSave.inModal, JSON.stringify(afterSave), s);
      await evaluate(s, "(()=>{document.querySelector('#rival-modal .modal-close').focus();return 1})()");
      await pressKey(s, 'Tab', 'Tab', 9, 8);
      const wrapBack = await evaluate(s, "(()=>{const a=document.activeElement;return {inModal:!!a.closest('#rival-modal'),id:a.id||a.className}})()");
      await rec('D11: Shift+Tab from the first control wraps to the last, still inside the modal', wrapBack.inModal, JSON.stringify(wrapBack), s);

      // D13: duplicate / me-equal name hints while typing.
      await evaluate(s, "(()=>{const i=document.querySelector('#rival-name');i.value='bob';i.dispatchEvent(new Event('input',{bubbles:true}));return 1})()");
      const dupHint = await txt(s, '#rival-name-hint');
      await evaluate(s, "(()=>{const i=document.querySelector('#rival-name');i.value='nik';i.dispatchEvent(new Event('input',{bubbles:true}));return 1})()");
      const meHint = await txt(s, '#rival-name-hint');
      await rec('D13: typing an existing rival\'s name or my own name shows a hint in the modal',
        /already have a rival called "Bob"/.test(dupHint || '') && /your own name/.test(meHint || ''), `${dupHint} // ${meHint}`, s);

      await pressKey(s, 'Escape', 'Escape', 27);
      const restored = await evaluate(s, "document.activeElement && document.activeElement.id");
      await rec('D11: Escape closes the rival modal and returns focus to "Add rival"', restored === 'add-rival-btn', String(restored), s);

      // D11: my-icon flyout restores focus on Escape.
      await click(s, '#my-icon-btn', { settle: 300 });
      await evaluate(s, "(()=>{document.querySelector('.my-icon-swatch').focus();return 1})()");
      await pressKey(s, 'Escape', 'Escape', 27);
      await rec('D11: Escape on the icon flyout returns focus to the icon button',
        (await evaluate(s, "document.activeElement && document.activeElement.id")) === 'my-icon-btn', '', s);

      // D13: my name equal to a rival.
      await evaluate(s, "(()=>{const i=document.querySelector('#my-name');i.value='Carol';i.dispatchEvent(new Event('input',{bubbles:true}));return 1})()");
      const meClash = await txt(s, '#my-name-hint');
      await rec('D13: setting my name to a rival\'s name shows a hint next to the name field', /also called "Carol"/.test(meClash || ''), meClash, s);

      // D14: a future paste date is flagged in the save bar.
      await openPastePanel(s);
      await fillPaste(s, 'Aug 20\n95 89 91 9 64\nFinal score: 585', 'Aug 20\n90 80 91 9 64\nFinal score: 585');
      await evaluate(s, "(()=>{const d=document.querySelector('#paste-date');d.value='2030-01-01';d.dispatchEvent(new Event('input',{bubbles:true}));return 1})()");
      await sleep(200);
      const bar = await txt(s, '#paste-summary');
      await rec('D14: a paste dated in the future is warned about before saving', /Warning: 2030-01-01 is in the future/.test(bar || ''), bar, s);
    } finally { await closePage(cdpPort, s); }
  }

  /* ------------------------------------------- D7: WhatsApp import */
  {
    const s = await openSeeded(cdpPort, base, { maptapRivalsRivals: [rival('r1', 'Bob')], maptapRivalsMe: '"Nik"' });
    try {
      await setFile(s, '#wa-import-file', path.join(FILES, 'wa-ios.txt'));
      const opened = await evaluate(s, "!document.querySelector('#wa-modal').hidden");
      const overview = await txt(s, '#wa-overview');
      await rec('D7: an iOS export ([20/08/2026, 21:05:10] Name:) opens the import modal with 2 messages and 2 shares',
        opened && /2 messages/.test(overview || '') && /2 MapTap shares/.test(overview || ''), overview, s);
      await evaluate(s, `(()=>{for(const row of document.querySelectorAll('.wa-sender-row')){const sel=row.querySelector('select');sel.value=row.dataset.sender==='Nik'?'me':'rival:r1';sel.dispatchEvent(new Event('change'));}return 1})()`);
      const btn = await txt(s, '#wa-commit-btn');
      await rec('D7: mapping Nik to me and Bob to the rival previews "Import 1 game"', btn === 'Import 1 game', btn, s);
      await click(s, '#wa-commit-btn', { settle: 800 });
      const games = JSON.parse(await ls(s, 'maptapRivalsGames') || '[]');
      await rec('D7: the imported game is dated 2026-08-20 (DD/MM header read as day-first, not month 20)',
        games.length === 1 && games[0].date === '2026-08-20' && games[0].myScore === 585 - 5 - 9, JSON.stringify(games.map(g => g.date)), s);
    } finally { await closePage(cdpPort, s); }
  }

  /* ---------------------------------------------- two tabs propagate */
  {
    const a = await openSeeded(cdpPort, base, { maptapRivalsRivals: seed.rivals.slice(0, 1), maptapRivalsMe: '"Nik"' });
    const b = await newPage(cdpPort);
    dialogs(b);
    try {
      await goto(b, base + APP + '#history', { settle: 1500 });
      // A: save a pasted day through the paste panel, coordinate-clicking the
      // real Save button (not element.click(), which skips hit-testing).
      await openPastePanel(a);
      await fillPaste(a);
      await click(a, '#paste-save-all', { settle: 800 });
      await rec('two tabs: the pasted day is saved in tab A',
        (await evaluate(a, "JSON.parse(localStorage.getItem('maptapRivalsGames')||'[]').length")) === 1,
        await txt(a, '#paste-summary'), a);
      const inB = await waitForExpr(b, "document.querySelectorAll('#history-table tbody tr.history-day-row').length===1", { timeout: 5000 });
      await rec('two tabs: a game saved in tab A appears in tab B\'s History without a reload', inB, '', b);
      // B: delete that game through the styled confirm modal.
      await click(b, '#history-table button[aria-label="Delete game"]', { settle: 400 });
      await click(b, '#delete-game-confirm', { settle: 600 });
      const storedB = JSON.parse(await ls(b, 'maptapRivalsGames') || '[]');
      // Tab A must re-read the key rather than re-persist its own copy.
      const goneInA = await waitForExpr(a, "JSON.parse(localStorage.getItem('maptapRivalsGames')||'[]').length===0", { timeout: 5000 });
      const summaryA = await txt(a, '#dash-summary');
      await rec('two tabs: deleting it in tab B empties storage and tab A does not resurrect it',
        storedB.length === 0 && goneInA && !/over 1 game/.test(summaryA || ''), `B:${storedB.length} A:${summaryA}`, a);
    } finally { await closePage(cdpPort, a); await closePage(cdpPort, b); }
  }

  return R;
}
