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

  return R;
}
