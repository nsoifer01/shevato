// E2E: the squad a Free Hit hands back.
//
// A Free Hit team exists for ONE gameweek. `entry/{id}/event/{fhGw}/picks/`
// therefore returns a RENTED fifteen, and the planner used to read it as the
// squad the manager owns and plan the NEXT gameweek from it: it recommended
// selling players he did not own and keeping players he never had. This suite
// stands in the real shape (the Free Hit gameweek frozen, the next one being
// planned) and checks what a manager actually sees on the page.
//
// Three states, because the fix has three distinct behaviours:
//   A. the squad the chip reverts to is readable  -> plan from the real squad
//   B. it is not readable                          -> withhold advice, say why
//   C. the Free Hit gameweek is the one being planned -> keep the rented team
import {
  recorder, openPlanner, heroRead, waitPlan, waitForExpr, evaluate, errorsOf,
  payloadsFor, proxyRule, clickText, activeView, TEAM_ID, APP,
} from './helpers.mjs';
import { closePage, newPage, interceptNetwork, goto, setViewport, screenshot } from '../../../tests/browser/cdp.mjs';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const SHOTS = path.join(REPO, '.screenshots', 'e2e-fpl-free-hit');

/**
 * Build the Free Hit shape from the in-season sample: the frozen gameweek
 * becomes a Free Hit whose fifteen are six players the manager never owned,
 * and the gameweek before it keeps his real squad.
 *
 * Returns the payload set plus the two id lists the assertions compare.
 */
async function freeHitPayloads({ rentedReadable = true } = {}) {
  const p = await payloadsFor('inseason', { teamId: TEAM_ID });
  const fhGw = p.picksGw;

  // The persistent squad: the gameweek before the chip, as FPL serves it.
  const prior = JSON.parse(JSON.stringify(p.picks));
  prior.active_chip = null;
  prior.entry_history = { ...prior.entry_history, event: fhGw - 1 };
  const persistentIds = prior.picks.map((x) => x.element);

  // The rented fifteen, kept legal (a real Free Hit team respects the
  // 3-per-club limit, and an illegal one makes the planner refuse for an
  // unrelated reason).
  const rented = JSON.parse(JSON.stringify(p.picks));
  rented.active_chip = 'freehit';
  const owned = new Set(rented.picks.map((x) => x.element));
  const byId = new Map(p.bootstrap.elements.map((e) => [e.id, e]));
  const clubs = new Map();
  for (const pick of rented.picks) {
    const t = byId.get(pick.element).team;
    clubs.set(t, (clubs.get(t) || 0) + 1);
  }
  let swapped = 0;
  for (const pick of rented.picks) {
    if (swapped >= 6) break;
    const me = byId.get(pick.element);
    const alt = p.bootstrap.elements.find((e) => e.element_type === me.element_type
      && e.team !== me.team && !owned.has(e.id) && (clubs.get(e.team) || 0) < 3);
    if (!alt) continue;
    clubs.set(me.team, clubs.get(me.team) - 1);
    clubs.set(alt.team, (clubs.get(alt.team) || 0) + 1);
    owned.add(alt.id);
    pick.element = alt.id;
    swapped++;
  }
  const rentedIds = rented.picks.map((x) => x.element);
  const rentedOnly = rentedIds.filter((id) => !persistentIds.includes(id));
  const nameOf = (id) => (byId.get(id) || {}).web_name;
  const persistentNames = persistentIds.map(nameOf);
  const rentedOnlyNames = rentedOnly.map(nameOf);

  // The chip in the durable record, which is what a reload reads.
  p.history = JSON.parse(JSON.stringify(p.history));
  p.history.chips = [...(p.history.chips || []), { name: 'freehit', time: '2026-01-01T00:00:00Z', event: fhGw }];
  p.picks = rented;

  // The prior gameweek's picks are served (or withheld) through `extra`.
  const priorPath = `entry/${TEAM_ID}/event/${fhGw - 1}/picks`;
  const extra = (qs) => {
    if (qs !== priorPath) return null;
    if (!rentedReadable) {
      return { status: 404, body: { error: 'not_found' }, headers: { 'x-fpl-cache': 'miss' } };
    }
    return { status: 200, body: prior, headers: { 'x-fpl-cache': 'hit', 'x-fpl-stale': 'false' } };
  };

  return {
    p, extra, fhGw, planGw: p.planGw,
    persistentIds, rentedIds, rentedOnly, swapped,
    persistentNames, rentedOnlyNames,
  };
}

/** Open the planner against a hand-built payload set. */
async function openWith(cdpPort, base, { p, extra }, { viewport = [1280, 900] } = {}) {
  const s = await newPage(cdpPort);
  await setViewport(s, viewport[0], viewport[1], viewport[0] < 700);
  await interceptNetwork(s, proxyRule(p, { extra }));
  await goto(s, base + APP, { settle: 250 });
  // The app caches every proxy response under `fpl-planner:cache:<path>` in
  // localStorage, which is per ORIGIN and therefore outlives the page. Without
  // this, the block that withholds the prior gameweek would be answered from
  // the block that served it, and the withheld case would silently never run.
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

// The pitch identifies a player by NAME, not by id, so the assertions compare
// the names a manager actually reads off the cards.
const shownNames = (s) => evaluate(s, `(()=>{
  return [...new Set([...document.querySelectorAll('.fpl-pp-name')].map(e => e.textContent.trim()))];
})()`);

// The cards the plan marks SELL. `.fpl-pp-move.is-out` is the transfer marker,
// and its card's name is the player being sold.
const sellNames = (s) => evaluate(s, `(()=>{
  return [...document.querySelectorAll('.fpl-pp-move.is-out')]
    .map(m => { const c = m.closest('.fpl-pp'); const n = c && c.querySelector('.fpl-pp-name'); return n ? n.textContent.trim() : null; })
    .filter(Boolean);
})()`);

export async function run({ base, cdpPort }) {
  const R = [];
  const rec = recorder(R);
  await mkdir(SHOTS, { recursive: true });

  /* ---- A. the reverted squad is readable: plan from the REAL fifteen ---- */
  {
    const setup = await freeHitPayloads({ rentedReadable: true });
    const s = await openWith(cdpPort, base, setup);
    try {
      await rec('A the fixture really rents six players', setup.swapped === 6 && setup.rentedOnly.length === 6,
        `swapped ${setup.swapped}, rented-only ${setup.rentedOnly.length}`, s);

      const ready = await waitPlan(s);
      await rec('A a plan is produced after the Free Hit', ready, '', s);
      await screenshot(s, path.join(SHOTS, 'A-reverted-1280.png'));

      const shown = await shownNames(s);
      const rentedShown = shown.filter((n) => setup.rentedOnlyNames.includes(n));
      await rec('A no rented player is on the page',
        shown.length > 0 && rentedShown.length === 0,
        `showing ${shown.length} players, rented on screen: ${rentedShown.join(',') || 'none'}`, s);

      // The default pitch is the RECOMMENDED squad, so a sold player is
      // legitimately absent from it. "Which fifteen does the app think he
      // owns" is the Current team view, and that is what must be the
      // persistent squad exactly.
      await clickText(s, 'Current team', { settle: 700 });
      const view = await activeView(s);
      const current = await shownNames(s);
      const missing = setup.persistentNames.filter((n) => !current.includes(n));
      const extraShown = current.filter((n) => !setup.persistentNames.includes(n));
      await rec('A the Current team view IS the persistent squad',
        view === 'Current team' && missing.length === 0 && extraShown.length === 0,
        `view "${view}", missing: ${missing.join(',') || 'none'}, unexpected: ${extraShown.join(',') || 'none'}`, s);

      const hero = await heroRead(s);
      const bannerText = hero.banners.join(' | ');
      await rec('A the manager is told his squad came back from the Free Hit',
        /Free Hit/i.test(bannerText), bannerText.slice(0, 160), s);

      await rec('A the plan is for the gameweek AFTER the Free Hit',
        String(hero.gw || '').includes(String(setup.planGw)), `gw label "${hero.gw}", planGw ${setup.planGw}`, s);

      // Any transfer offered must sell a player the manager actually owns.
      const sells = await sellNames(s);
      const sellingUnowned = sells.filter((n) => !setup.persistentNames.includes(n));
      await rec('A no recommended transfer sells a player he does not own',
        sellingUnowned.length === 0,
        `plan sells [${sells.join(',') || 'nothing'}]; unowned: ${sellingUnowned.join(',') || 'none'}`, s);

      await rec('A no console errors', errorsOf(s).length === 0, errorsOf(s).slice(0, 2).join(' | '), s);
    } finally { await closePage(cdpPort, s); }
  }

  /* ---- B. the reverted squad is NOT readable: withhold, and say why ---- */
  {
    const setup = await freeHitPayloads({ rentedReadable: false });
    const s = await openWith(cdpPort, base, setup);
    try {
      const ready = await waitPlan(s);
      await rec('B the app still renders rather than failing', ready, '', s);
      await screenshot(s, path.join(SHOTS, 'B-withheld-1280.png'));

      const body = await evaluate(s, 'document.body.textContent');
      await rec('B the page says this is the Free Hit team, not the squad he keeps',
        /Free Hit team/i.test(body), '', s);

      const sells = await sellNames(s);
      await rec('B no transfer is recommended against a squad he does not keep',
        sells.length === 0, `plan sells [${sells.join(',') || 'nothing'}]`, s);

      await rec('B no console errors', errorsOf(s).length === 0, errorsOf(s).slice(0, 2).join(' | '), s);
    } finally { await closePage(cdpPort, s); }
  }

  /* ---- C. mobile: the revert notice is readable at 390 ---- */
  {
    const setup = await freeHitPayloads({ rentedReadable: true });
    const s = await openWith(cdpPort, base, setup, { viewport: [390, 844] });
    try {
      await waitPlan(s);
      await screenshot(s, path.join(SHOTS, 'C-reverted-390.png'));
      const overflow = await evaluate(s,
        `document.documentElement.scrollWidth - document.documentElement.clientWidth`);
      await rec('C no horizontal overflow at 390 with the Free Hit banner', overflow <= 0, `overflow ${overflow}`, s);
      const shown = await shownNames(s);
      const rentedShown = shown.filter((n) => setup.rentedOnlyNames.includes(n));
      await rec('C the phone shows the persistent squad too', rentedShown.length === 0,
        `rented on screen: ${rentedShown.join(',') || 'none'}`, s);
    } finally { await closePage(cdpPort, s); }
  }

  return R;
}
