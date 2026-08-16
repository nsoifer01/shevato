// E2E: the interactive "My scenario" workflow.
//
// This suite exists because the sandbox shipped with passing unit and DOM tests
// and was still unusable: every interaction bounced the user back to the
// Recommended view. Nothing that inspects state can see that, because the state
// was correct; what was wrong was which view the app re-rendered into. So every
// check here reads the ACTIVE TAB off the DOM after a real click, in the two
// squad states the app actually ships in (pre-season, where no picks exist, and
// in-season).
import { closePage } from '../../../tests/browser/cdp.mjs';
import {
  recorder, openPlanner, openScenario, clickText, clickPlayer, transferOut,
  activeView, viewTabs, scenarioRead, waitForExpr, evaluate, sleep, errorsOf,
  clickSel, waitPlan,
} from './helpers.mjs';

const SCENARIO = 'My scenario';

export async function run({ base, cdpPort }) {
  const R = [];
  const rec = recorder(R);

  // The two states matter separately: pre-season has NO picks, which is the
  // case the regression lived in and the case every user is in this week.
  for (const state of ['inseason', 'preseason']) {
    const s = await openPlanner(cdpPort, base, { state });
    const label = `[${state}]`;

    try {
      const tabs = await viewTabs(s);
      await rec(`${label} the scenario view is offered`, tabs.includes(SCENARIO), tabs.join(' | '), s);

      await openScenario(s);
      await rec(`${label} opening it makes it the active view`, await activeView(s) === SCENARIO, await activeView(s), s);

      /* --------------------------- 1. player drawer round trip ------------- */
      let v = await scenarioRead(s);
      const someone = v.xi[3];
      await clickPlayer(s, someone);
      await rec(`${label} clicking a player STAYS in the scenario`,
        await activeView(s) === SCENARIO, `now on: ${await activeView(s)}`, s);
      await rec(`${label} and opens the action bar for him`,
        (await scenarioRead(s)).actionWho?.includes(someone), (await scenarioRead(s)).actionWho, s);

      await clickText(s, 'Player details');
      await waitForExpr(s, `!!document.querySelector('.fpl-dw-overlay')`, { timeout: 6000 });
      await rec(`${label} the player drawer opens from the scenario`,
        (await scenarioRead(s)).drawer, '', s);
      await evaluate(s, `(()=>{const b=document.querySelector('.fpl-dw-overlay button');if(b)b.click();return 1})()`);
      await sleep(400);
      await rec(`${label} closing the drawer returns to the scenario`,
        await activeView(s) === SCENARIO && !(await scenarioRead(s)).drawer, `now on: ${await activeView(s)}`, s);

      /* --------------------------- 2. bench swap --------------------------- */
      v = await scenarioRead(s);
      const beforeXi = v.xi.slice();
      const sub = v.bench.find((n) => !!n);
      await clickPlayer(s, sub);
      await clickText(s, 'Swap into the eleven');
      await rec(`${label} entering swap mode stays in the scenario`,
        await activeView(s) === SCENARIO, `now on: ${await activeView(s)}`, s);
      const target = await evaluate(s, `(()=>{const c=document.querySelector('.fpl-pp-edit.is-target');
        return c?c.querySelector('.fpl-pp-name').textContent.trim():null})()`);
      if (target) await clickPlayer(s, target);
      v = await scenarioRead(s);
      await rec(`${label} the swap actually changes the eleven`,
        v.xi.includes(sub) && !v.xi.includes(target), `${target} out, ${sub} in`, s);
      await rec(`${label} the eleven is still eleven`, v.xi.length === 11, `${v.xi.length}`, s);
      await rec(`${label} the swap keeps the scenario active`,
        await activeView(s) === SCENARIO, `now on: ${await activeView(s)}`, s);

      /* --------------------------- 3. captain ------------------------------ */
      v = await scenarioRead(s);
      const capTarget = v.xi.find((n) => n !== v.captain && n !== v.vice);
      await clickPlayer(s, capTarget);
      await clickText(s, 'Make captain');
      v = await scenarioRead(s);
      await rec(`${label} the armband moves`, v.captain === capTarget, `${v.captain}`, s);
      await rec(`${label} changing the captain keeps the scenario active`,
        await activeView(s) === SCENARIO, `now on: ${await activeView(s)}`, s);

      /* --------------------------- 4. expected points ---------------------- */
      await clickText(s, 'Show expected points');
      v = await scenarioRead(s);
      await rec(`${label} expected points appear on the cards`, v.detailCards >= 11, `${v.detailCards} cards`, s);
      await rec(`${label} the toggle keeps the scenario active`,
        await activeView(s) === SCENARIO, `now on: ${await activeView(s)}`, s);
      await clickText(s, 'Hide expected points');

      /* --------------------------- 5. a manual transfer -------------------- */
      v = await scenarioRead(s);
      const bankBefore = v.cmp.find((c) => /bank/i.test(c.k))?.after;
      const sellName = v.xi.find((n) => n !== v.captain);
      const bought = await transferOut(s, sellName);
      await rec(`${label} a replacement can be chosen`, !!bought, `${sellName} -> ${bought}`, s);
      v = await scenarioRead(s);
      await rec(`${label} the incoming player is in the squad`,
        [...v.xi, ...v.bench].includes(bought), bought, s);
      await rec(`${label} the outgoing player is gone`,
        ![...v.xi, ...v.bench].includes(sellName), sellName, s);
      await rec(`${label} the bank changed`,
        v.cmp.find((c) => /bank/i.test(c.k))?.after !== bankBefore,
        `${bankBefore} -> ${v.cmp.find((c) => /bank/i.test(c.k))?.after}`, s);
      await rec(`${label} the transfer is listed`, v.moves.length >= 1, v.moves.join(' / '), s);
      await rec(`${label} the transfer keeps the scenario active`,
        await activeView(s) === SCENARIO, `now on: ${await activeView(s)}`, s);

      /* --------------------------- 6. sequential actions ------------------- */
      // The point of this block is that NOTHING resets between steps: the view
      // stays put and every earlier edit survives.
      const editsBefore = (await scenarioRead(s)).moves.length;
      const steps = [];
      const capNow = (await scenarioRead(s)).captain;
      const other = (await scenarioRead(s)).xi.find((n) => n !== capNow);
      await clickPlayer(s, other);
      steps.push(['select a player', await activeView(s)]);
      await clickText(s, 'Make vice');
      steps.push(['make vice', await activeView(s)]);
      await clickText(s, 'Show expected points');
      steps.push(['show expected points', await activeView(s)]);
      await clickText(s, 'Hide expected points');
      steps.push(['hide expected points', await activeView(s)]);
      const v2 = await scenarioRead(s);
      await rec(`${label} every sequential action stays in the scenario`,
        steps.every(([, view]) => view === SCENARIO),
        steps.map(([n, view]) => `${n}=${view}`).join(', '), s);
      await rec(`${label} earlier edits survive the sequence`,
        v2.moves.length === editsBefore && v2.edited, `${v2.moves.length} moves, edited=${v2.edited}`, s);

      /* --------------------------- 7. recommend from here ------------------ */
      await clickText(s, 'Ask the planner from this team');
      const got = await waitForExpr(s, `!!document.querySelector('.fpl-scenario-plan')`, { timeout: 90000 });
      const v3 = await scenarioRead(s);
      await rec(`${label} the planner answers from the scenario`, got && v3.scenarioPlan, '', s);
      await rec(`${label} asking does not navigate away`,
        await activeView(s) === SCENARIO, `now on: ${await activeView(s)}`, s);
      await rec(`${label} the scenario itself survives the answer`,
        v3.moves.length === editsBefore && v3.edited, `${v3.moves.length} moves`, s);

      /* --------------------------- 8. reset -------------------------------- */
      await clickText(s, 'Reset to my team');
      const v4 = await scenarioRead(s);
      await rec(`${label} reset restores the imported squad`,
        v4.moves.length === 0 && !v4.edited, `${v4.moves.length} moves, edited=${v4.edited}`, s);
      await rec(`${label} reset keeps the scenario active`,
        await activeView(s) === SCENARIO, `now on: ${await activeView(s)}`, s);

      // The recommended squad must not have been touched by any of this.
      await clickText(s, 'Recommended');
      await sleep(400);
      const recCards = await evaluate(s, `document.querySelectorAll('.fpl-pp').length`);
      await rec(`${label} the recommended view still renders its own squad`, recCards >= 15, `${recCards}`, s);
      await clickText(s, SCENARIO);
      await sleep(300);
      await rec(`${label} and the scenario is still reachable afterwards`,
        await activeView(s) === SCENARIO, `now on: ${await activeView(s)}`, s);

      const errs = errorsOf(s);
      await rec(`${label} no console errors through the whole workflow`, errs.length === 0, errs.slice(0, 2).join(' | '), s);
    } finally {
      await closePage(cdpPort, s);
    }
  }

  /* ============== interaction stability (the flicker/jump regressions) ====
     The 2026-08 rework's root causes, pinned as user-visible behaviour:
     every click used to rebuild the whole app DOM (killing scroll anchoring
     and focus), swap mode grew every card by a blocked-reason line, the
     picker force-scrolled the page to itself, and a planner answer computed
     for an already-edited scenario could render over the newer state. */
  for (const [tag, viewport] of [['desktop', [1280, 900]], ['mobile', [390, 844]]]) {
    const s = await openPlanner(cdpPort, base, { state: 'inseason', viewport });
    const label = `[stability ${tag}]`;
    try {
      await openScenario(s);
      // Records scrollY at the instant each click lands, so the assertion
      // "the app did not scroll the page" excludes the driver's own
      // scroll-into-view before the click.
      await evaluate(s, `(()=>{ window.__st={y:null};
        document.addEventListener('click',()=>{window.__st.y=Math.round(window.scrollY)},true); return 1 })()`);
      const drift = () => evaluate(s, `window.__st.y===null? 0 : Math.round(window.scrollY)-window.__st.y`);
      const v = await scenarioRead(s);

      /* -- selecting must not rebuild the pitch, scroll the page, or move it */
      await evaluate(s, `(()=>{document.querySelector('.fpl-pitch-edit').scrollIntoView({block:'start'}); return 1})()`);
      await sleep(250);
      await evaluate(s, `(()=>{document.querySelector('.fpl-pitch-edit .fpl-pp-edit').dataset.probeMark='1'; return 1})()`);
      await clickPlayer(s, v.xi[1]);
      await rec(`${label} selecting does not scroll the page`, Math.abs(await drift()) <= 1, `drift ${await drift()}px`, s);
      await rec(`${label} selecting preserves the card DOM`,
        await evaluate(s, `!!document.querySelector('.fpl-pp-edit[data-probe-mark]')`),
        'the probe-marked card was destroyed and rebuilt', s);
      const dock = await evaluate(s, `(()=>{const d=document.querySelector('.fpl-dock');const r=d.getBoundingClientRect();
        return {top:Math.round(r.top),bottom:Math.round(r.bottom),vh:window.innerHeight,live:d.className.includes('is-live')}})()`);
      await rec(`${label} the action dock is pinned inside the viewport`,
        dock.live && dock.bottom <= dock.vh + 1 && dock.top >= 0, JSON.stringify(dock), s);
      const covered = await evaluate(s, `(()=>{
        const btns=[...document.querySelectorAll('.fpl-actionbar button')];
        return btns.filter(b=>{const r=b.getBoundingClientRect();
          const el=document.elementsFromPoint(r.left+r.width/2, r.top+r.height/2)[0];
          return !(el===b||b.contains(el));}).length;
      })()`);
      await rec(`${label} every action button is clickable at its own centre`, covered === 0, `${covered} covered`, s);

      /* -- swap mode must not change any card's size (it used to grow all) -- */
      const cardH = await evaluate(s, `Math.round(document.querySelector('.fpl-pitch-edit .fpl-pp-edit').getBoundingClientRect().height)`);
      await clickText(s, v.xi[1] === (await scenarioRead(s)).captain ? 'Swap with a substitute' : 'Swap with a substitute');
      const cardH2 = await evaluate(s, `Math.round(document.querySelector('.fpl-pitch-edit .fpl-pp-edit').getBoundingClientRect().height)`);
      await rec(`${label} entering swap mode does not resize the cards`, cardH === cardH2, `${cardH} -> ${cardH2}`, s);
      await rec(`${label} entering swap mode does not scroll the page`, Math.abs(await drift()) <= 1, `drift ${await drift()}px`, s);
      await rec(`${label} legal targets are marked`,
        (await evaluate(s, `document.querySelectorAll('.fpl-pp-edit.is-target').length`)) > 0, '', s);
      await clickText(s, 'Cancel');

      /* -- captain: page still, selection kept, armband visible ------------ */
      let vv = await scenarioRead(s);
      const capTarget = vv.xi.find((n) => n !== vv.captain && n !== vv.vice);
      await clickPlayer(s, capTarget);
      await clickText(s, 'Make captain');
      await rec(`${label} making captain does not scroll the page`, Math.abs(await drift()) <= 1, `drift ${await drift()}px`, s);
      vv = await scenarioRead(s);
      await rec(`${label} the armband lands and the player stays selected`,
        vv.captain === capTarget && vv.actionWho?.includes(capTarget), `${vv.captain} / ${vv.actionWho}`, s);
      await clickText(s, 'Done');

      /* -- picker: opens where pressed, no page scroll, typed text survives  */
      vv = await scenarioRead(s);
      const sellName = vv.xi.find((n) => n !== vv.captain && n !== vv.vice);
      const pitchTopBefore = await evaluate(s, `Math.round(document.querySelector('.fpl-pitch-edit').getBoundingClientRect().top + window.scrollY)`);
      await clickPlayer(s, sellName);
      await clickText(s, 'Transfer out');
      await waitForExpr(s, `!!document.querySelector('.fpl-cb-list li')`, { timeout: 8000 });
      await rec(`${label} opening the picker does not scroll the page`, Math.abs(await drift()) <= 1, `drift ${await drift()}px`, s);
      const pickerBox = await evaluate(s, `(()=>{const p=document.querySelector('.fpl-picker');const r=p.getBoundingClientRect();
        return {top:Math.round(r.top),bottom:Math.round(r.bottom),vh:window.innerHeight}})()`);
      await rec(`${label} the picker is inside the viewport without hunting`,
        pickerBox.top >= 0 && pickerBox.bottom <= pickerBox.vh + 1, JSON.stringify(pickerBox), s);
      await rec(`${label} the search box has focus`,
        await evaluate(s, `document.activeElement && document.activeElement.className.includes('fpl-cb-input')`), '', s);

      await evaluate(s, `(()=>{const i=document.querySelector('.fpl-cb-input'); i.value='van'; i.dispatchEvent(new Event('input')); return 1})()`);
      await clickText(s, 'Show expected points');       // an unrelated update while the picker is open
      await clickText(s, 'Hide expected points');
      const typed = await evaluate(s, `(()=>{const i=document.querySelector('.fpl-cb-input'); return i? i.value : null})()`);
      await rec(`${label} an unrelated update does not rebuild the open picker`, typed === 'van', `search box now: ${JSON.stringify(typed)}`, s);

      await evaluate(s, `(()=>{const i=document.querySelector('.fpl-cb-input'); i.value=''; i.dispatchEvent(new Event('input')); return 1})()`);
      await waitForExpr(s, `document.querySelectorAll('.fpl-cb-list li').length > 5`, { timeout: 4000 });
      const pick = await evaluate(s, `(()=>{
        const rows=[...document.querySelectorAll('.fpl-cb-list li')];
        const i=rows.findIndex(r=>!/He costs|You would have|Already in your squad/i.test(r.textContent));
        return i;
      })()`);
      await clickSel(s, '.fpl-cb-list li', { nth: pick, settle: 700 });
      const pitchTopAfter = await evaluate(s, `Math.round(document.querySelector('.fpl-pitch-edit').getBoundingClientRect().top + window.scrollY)`);
      await rec(`${label} completing a transfer does not move the pitch`,
        Math.abs(pitchTopAfter - pitchTopBefore) <= 1, `${pitchTopBefore} -> ${pitchTopAfter}`, s);
      await rec(`${label} the incoming player is highlighted`,
        await evaluate(s, `!!document.querySelector('.fpl-pp-edit.is-just-in')`), '', s);

      /* -- undo where the user is looking ---------------------------------- */
      const undone = await clickText(s, 'Undo last change');
      vv = await scenarioRead(s);
      await rec(`${label} "Undo last change" in the dock reverts the transfer`,
        undone && vv.moves.length === 0, `${vv.moves.length} moves listed`, s);

      /* -- no horizontal overflow anywhere in this flow -------------------- */
      const overX = await evaluate(s, `document.documentElement.scrollWidth - document.documentElement.clientWidth`);
      await rec(`${label} no horizontal overflow`, overX <= 0, `${overX}px of overflow`, s);

      /* -- a stale planner answer never overwrites newer edits ------------- */
      await clickText(s, 'Ask the planner from this team', { settle: 60 });
      vv = await scenarioRead(s);
      const lateCap = vv.xi.find((n) => n !== vv.captain && n !== vv.vice);
      await clickPlayer(s, lateCap, { settle: 60 });
      await clickText(s, 'Make captain', { settle: 60 });
      await waitForExpr(s, `![...document.querySelectorAll('button')].some(b=>/Asking the planner/.test(b.textContent))`, { timeout: 90000 });
      await sleep(400);
      const afterStale = await scenarioRead(s);
      await rec(`${label} an answer about an edited-away squad is discarded`,
        !afterStale.scenarioPlan, 'a stale planner card is on screen', s);
      await rec(`${label} the newer edit survives the stale answer`,
        afterStale.captain === lateCap, `${afterStale.captain}`, s);

      // And a fresh ask, after the edits, still answers.
      await clickText(s, 'Ask the planner from this team');
      const answered = await waitForExpr(s, `!!document.querySelector('.fpl-scenario-plan')`, { timeout: 90000 });
      await rec(`${label} a fresh ask after the edits still answers`, answered, '', s);

      const errs2 = errorsOf(s);
      await rec(`${label} no console errors through the stability checks`, errs2.length === 0, errs2.slice(0, 2).join(' | '), s);
    } finally {
      await closePage(cdpPort, s);
    }
  }

  return R;
}
