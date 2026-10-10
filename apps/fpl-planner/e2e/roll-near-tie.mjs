// E2E: the near-tie roll, where the card, the roll sentence and the confidence
// band have to tell one story.
//
// THE STATE (backend audit B7, 2026-10-09). The planner rolls with free
// transfers in hand while moves exist that project slightly MORE over the
// horizon and lose only because they spend free transfers worth keeping: on
// the committed sample, after the planner's own moves for five gameweeks of
// planning (applied below by the engine itself, so the fixture cannot drift
// from the code), it rolls with two free transfers while "E.Le Fee to
// Tavernier" projects about +0.2 and a two-move plan about +0.7, which spends
// two transfers worth 1.2. Before the fix the card said "none of them scored
// higher" above them, the roll sentence quoted the value of every banked
// transfer, it appeared twice under "Why this plan?", and the confidence band
// called the runner-up a tie.
//
// The demo data never reaches this state, which is why it is built here.
import {
  recorder, waitPlan, evaluate, errorsOf, payloadsFor, proxyRule, TEAM_ID, APP,
} from './helpers.mjs';
import { closePage, newPage, interceptNetwork, goto, setViewport, screenshot } from '../../../tests/browser/cdp.mjs';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { buildGameState } from '../js/engine/normalize.js';
import { buildSquadState } from '../js/engine/squad.js';
import { buildPlan } from '../js/engine/planner.js';
import { signedXp, xp } from '../js/ui/format.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const SHOTS = path.join(REPO, '.screenshots', 'e2e-fpl-roll-near-tie');

// The options js/app.js plans with by default (planOptions).
const APP_OPTIONS = { horizon: 5, risk: 'balanced', seed: 7 };

/**
 * Walk the sample team forward by the planner's own recommendations until it
 * rolls with a no-hit alternative that projects at least +0.1 more. Returns the
 * payloads in that state and the plan the engine makes from them.
 */
export async function nearTieRollPayloads() {
  const p = await payloadsFor('inseason', { teamId: TEAM_ID });
  for (let step = 0; step < 12; step++) {
    const gameState = buildGameState(p.bootstrap, p.fixtures, { fetchedAt: new Date().toISOString() });
    const squadState = buildSquadState({
      entry: p.entry, history: p.history, transfers: p.transfers, picks: p.picks, gameState, gw: p.planGw,
    });
    const bundle = await buildPlan({ gameState, squadState, options: APP_OPTIONS });
    const plan = bundle.current;
    if (!plan.transferCount && !plan.chip) {
      const ahead = plan.alternatives.filter(a => !a.hits && !a.chip && a.deltaHorizon >= 0.05);
      return { p, plan, ahead, step };
    }
    for (let i = 0; i < plan.transfersOut.length; i++) {
      const pick = p.picks.picks.find(x => x.element === plan.transfersOut[i]);
      pick.element = plan.transfersIn[i];
    }
    p.picks.entry_history.bank = plan.bankAfterTenths;
    // FPL's frozen squad value is the fifteen at deadline prices plus the bank
    // (README, entry_history.value), so a moved squad carries its own value and
    // the page does not open on a "does not match" warning about the fixture.
    const listed = new Map(p.bootstrap.elements.map(e => [e.id, e.now_cost - (e.cost_change_event || 0)]));
    p.picks.entry_history.value = p.picks.picks.reduce((sum, x) => sum + listed.get(x.element), 0) + plan.bankAfterTenths;
  }
  return { p, plan: null, ahead: [], step: -1 };
}

async function openWith(cdpPort, base, p, viewport) {
  const s = await newPage(cdpPort);
  await setViewport(s, viewport[0], viewport[1], viewport[0] < 700);
  await interceptNetwork(s, proxyRule(p));
  await goto(s, base + APP, { settle: 250 });
  await evaluate(s, `(()=>{
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith('fpl-planner:') || k.startsWith('fplPlanner')) localStorage.removeItem(k);
    }
    localStorage.setItem('fplPlannerTeamId', ${JSON.stringify(JSON.stringify(String(TEAM_ID)))});
    return 1;
  })()`);
  await goto(s, base + APP, { settle: 900 });
  return s;
}

// Opens a disclosure by its summary text and returns its text content.
const openDisclosure = (s, prefix) => evaluate(s, `(()=>{
  const d = [...document.querySelectorAll('details')].find(x => {
    const sum = x.querySelector('summary');
    return sum && sum.textContent.trim().startsWith(${JSON.stringify(prefix)});
  });
  if (!d) return null;
  d.open = true;
  return d.textContent.replace(/\\s+/g, ' ').trim();
})()`);

const altRows = (s) => evaluate(s, `(()=>[...document.querySelectorAll('.fpl-alt')].map(r => ({
  title: (r.querySelector('.fpl-alt-title') || {}).textContent || '',
  delta: ((r.querySelector('.fpl-alt-delta') || {}).textContent || '').replace(/\\s+/g, ' ').trim(),
})))()`);

const countOf = (text, needle) => text.split(needle).length - 1;

export async function run({ base, cdpPort }) {
  const R = [];
  const rec = recorder(R);
  await mkdir(SHOTS, { recursive: true });

  const fixture = await nearTieRollPayloads();
  await rec('the fixture reaches a roll with a no-hit move that projects more',
    fixture.plan && fixture.ahead.length > 0,
    fixture.plan ? `step ${fixture.step}, ahead ${fixture.ahead.map(a => `${a.headline} ${signedXp(a.deltaHorizon)}`).join('; ')}` : 'never rolled');
  if (!fixture.plan || !fixture.ahead.length) return R;
  const per = fixture.ahead[0].rollPerTransfer;

  for (const viewport of [[1280, 900], [390, 844]]) {
    const tag = `${viewport[0]}`;
    const s = await openWith(cdpPort, base, fixture.p, viewport);
    try {
      const ready = await waitPlan(s);
      await rec(`${tag} the plan renders`, ready, '', s);

      const hero = await evaluate(s, `document.body.textContent.replace(/\\s+/g, ' ')`);
      await rec(`${tag} the hero rolls`, /Roll your transfer/.test(hero), '', s);

      const altText = await openDisclosure(s, 'Alternatives considered');
      await rec(`${tag} the alternatives card exists`, !!altText, '', s);
      await rec(`${tag} the card never says nothing scored higher above moves that did`,
        altText && !/none of them scored higher/.test(altText), altText && altText.slice(0, 160), s);
      await rec(`${tag} the card names the value of a kept transfer, per transfer`,
        altText && altText.includes(`Each free transfer kept is worth ${xp(per)} points next week`), '', s);

      // Every row against the engine's own numbers, one decimal as printed.
      const rows = await altRows(s);
      const expected = fixture.plan.alternatives;
      await rec(`${tag} the card lists the engine's alternatives in order`,
        rows.length === expected.length && rows.every((r, i) => r.title.trim() === expected[i].headline),
        rows.map(r => r.title).join(' | '), s);
      for (let i = 0; i < Math.min(rows.length, expected.length); i++) {
        const a = expected[i];
        const r = rows[i];
        await rec(`${tag} row ${i + 1} prints the engine's gap`, r.delta.startsWith(`${signedXp(a.deltaHorizon)} pts`), r.delta, s);
        if (a.belowRollValue) {
          const spent = a.transfersSpentVsPlan > 1 ? `${a.transfersSpentVsPlan} free transfers` : 'a free transfer';
          await rec(`${tag} row ${i + 1} says what it spends, and it outweighs the gain`,
            r.delta.includes(`but spends ${spent} worth ${xp(a.rollMarginPoints)} to keep`) && a.rollMarginPoints >= a.deltaHorizon - 1e-9,
            r.delta, s);
        }
      }

      // "Why this plan?": the roll sentence once, per transfer, and the
      // confidence band agreeing that the runner-up projects more.
      const why = await openDisclosure(s, 'Why this plan?');
      const rollSentence = `Each free transfer kept is worth ${xp(per)} points of future flexibility`;
      await rec(`${tag} the roll sentence appears exactly once under Why this plan?`,
        why && countOf(why, rollSentence) === 1, why && `${countOf(why, rollSentence)}x`, s);
      const lead = Math.max(...expected.map(a => a.deltaHorizon));
      await rec(`${tag} confidence does not call a runner-up that projects more a tie`,
        why && !/projects the same points/.test(why) && why.includes(`projects ${xp(lead)} more points over the horizon`),
        why && (why.match(/next best plan[^.]*\./) || [''])[0], s);

      await evaluate(s, `(()=>{ const d = [...document.querySelectorAll('details')].find(x => (x.querySelector('summary') || {}).textContent?.trim().startsWith('Alternatives considered')); if (d) d.scrollIntoView({ block: 'start' }); return 1; })()`);
      await screenshot(s, path.join(SHOTS, `alternatives-${tag}.png`));
      const overflow = await evaluate(s, 'document.documentElement.scrollWidth - document.documentElement.clientWidth');
      const wide = overflow > 0 ? await evaluate(s, `(()=>{
        const W = document.documentElement.clientWidth;
        return [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > W + 1 && e.getClientRects().length)
          .slice(0, 6).map(e => e.tagName.toLowerCase() + '.' + String(e.className).trim().split(/\\s+/).join('.') + ' ' + Math.round(e.getBoundingClientRect().right));
      })()`) : [];
      await rec(`${tag} no horizontal overflow`, overflow <= 0, `overflow ${overflow} ${wide.join(' | ')}`, s);
      await rec(`${tag} no console errors`, errorsOf(s).length === 0, errorsOf(s).slice(0, 2).join(' | '), s);
    } finally { await closePage(cdpPort, s); }
  }
  return R;
}
