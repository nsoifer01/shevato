// Trip Planner E2E: interaction chrome.
//   M. dialog mechanics (Escape, backdrop, focus trap, focus return,
//      layer-at-a-time closing, background isolation)
//   N. keyboard shortcuts and their editable-field guards
//   P. responsive smoke at desktop and phone widths
//
// The app has ~10 dialogs sharing one overlay mechanism; M tests the shared
// mechanism plus representative dialogs rather than every modal separately.
import {
  recorder, freshIds, dbOf, standardTrip,
  openApp, readDb, overlayOpenId, tpErrors, openAddItem,
  switchView, escape, closePage, evaluate,
  clickSel, pressKey, sleep,
} from './helpers.mjs';
import { clickAt } from '../../../tests/browser/cdp.mjs';

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
    await sleep(200);
    await t('tp-ui M: Escape closes a dialog', (await overlayOpenId(s)) === null, '', s);
    await t('tp-ui M: focus returns to the opener', (await evaluate(s, `document.activeElement && document.activeElement.id`)) === 'addBtn', '', s);

    // backdrop closes, and the click never reaches controls behind the overlay
    await openAddItem(s);
    const undoDisabledBefore = await evaluate(s, `document.getElementById('undoBtn').disabled`);
    const box = await evaluate(s, `(()=>{const r=document.getElementById('undoBtn').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    await clickAt(s, box.x, box.y); // lands on the backdrop covering the toolbar
    await sleep(400);
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
    await sleep(300);
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
    await sleep(300);
    await t('tp-ui N: "n" opens Add item', (await overlayOpenId(s)) === 'itemOverlay', '', s);
    await escape(s);

    // ? opens the shortcut list, Escape closes it, focus comes back
    await clickSel(s, '#shortcutsBtn', { settle: 400 });
    await t('tp-ui N: the ? button opens the shortcut list', (await overlayOpenId(s)) === 'shortcutsOverlay', '', s);
    await escape(s);
    await t('tp-ui N: focus returns to the ? button', (await evaluate(s, `document.activeElement && document.activeElement.id`)) === 'shortcutsBtn', '', s);
    await pressKey(s, '?', 'Slash', 191, 8);
    await sleep(300);
    await t('tp-ui N: the ? key opens the list too', (await overlayOpenId(s)) === 'shortcutsOverlay', '', s);
    await escape(s);

    // shortcut keys typed into editable controls must reach the control
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

  return R;
}
