// E2E: plan history belongs to one team and season (2026-10-25).
//
// The stored history was one map for whoever was planned last, so opening a
// second team in the same browser showed "Plan updated" against the first
// team's plan and listed the first team's plans in its History tab (found
// verifying #628 in production). One browser session, two teams, switched the
// way a manager switches them (Settings -> "Use a different Team ID"), then a
// recalculation, a switch back, a reload and demo mode, reading what the page
// says each time.
import {
  recorder, waitPlan, evaluate, waitForExpr, errorsOf, payloadsFor, proxyRule, clickText, TEAM_ID, APP,
} from './helpers.mjs';
import { closePage, newPage, interceptNetwork, goto, setViewport, typeInto } from '../../../tests/browser/cdp.mjs';

const TEAM_B = 7654321;

// Team B: the sample squad with four players swapped for others of the same
// position (the club limit kept), under another id and name, so its plan is
// recognisably not team A's.
async function teamB(teamId = TEAM_B) {
  const p = await payloadsFor('inseason', { teamId });
  const byId = new Map(p.bootstrap.elements.map((e) => [e.id, e]));
  const held = new Set(p.picks.picks.map((x) => x.element));
  const clubs = new Map();
  for (const id of held) clubs.set(byId.get(id).team, (clubs.get(byId.get(id).team) || 0) + 1);
  let swapped = 0;
  for (const pick of p.picks.picks) {
    if (swapped >= 4) break;
    const me = byId.get(pick.element);
    const alt = p.bootstrap.elements.find((e) => e.element_type === me.element_type && !held.has(e.id)
      && e.team !== me.team && (clubs.get(e.team) || 0) < 3 && e.now_cost <= me.now_cost && e.status === 'a');
    if (!alt) continue;
    clubs.set(me.team, clubs.get(me.team) - 1);
    clubs.set(alt.team, (clubs.get(alt.team) || 0) + 1);
    held.delete(me.id);
    held.add(alt.id);
    pick.element = alt.id;
    swapped++;
  }
  p.entry = { ...p.entry, id: teamId, name: `Team ${teamId}` };
  // Only the squad in this gameweek differs; a transfer list that does not
  // explain it would be a different (and reported) inconsistency.
  p.transfers = [];
  return p;
}

// What the page says about the plan and its history right now.
const read = (s) => evaluate(s, `(()=>{
  const t = (x) => { const e = document.querySelector(x); return e ? e.textContent.trim() : null; };
  return {
    team: t('.fpl-team-name') || t('h2'),
    headline: t('.fpl-hero-headline'),
    changed: !!document.querySelector('.fpl-change'),
    unchanged: !!document.querySelector('.fpl-unchanged'),
    previously: t('.fpl-change .is-prev'),
    rebuilt: [...document.querySelectorAll('.fpl-banner-title')].some((b) => /Plan rebuilt/.test(b.textContent)),
  };
})()`);

// The Saved plans list on the History tab: one recommendation line per stored version.
async function savedPlans(s) {
  await clickText(s, 'History', { settle: 600 });
  await waitForExpr(s, `[...document.querySelectorAll('summary,button,h2,h3,.fpl-card-title')].some((n) => /Saved plans/.test(n.textContent))`, { timeout: 8000 });
  const out = await evaluate(s, `(()=>{
    const d = [...document.querySelectorAll('details')].find((x) => /Saved plans/.test(x.textContent));
    if (d) d.open = true;
    return {
      rows: d ? [...d.querySelectorAll('td.is-rec')].map((td) => td.textContent.trim()) : [],
      empty: d ? /Nothing has been saved/.test(d.textContent) : null,
      gameweeks: d ? [...d.querySelectorAll('.fpl-subhead')].map((h) => h.textContent.trim()).filter((t) => /^Gameweek \\d+$/.test(t)) : [],
    };
  })()`);
  await clickText(s, 'Plan', { settle: 600 });
  return out;
}

async function switchTo(s, teamId) {
  await clickText(s, 'Settings', { settle: 600 });
  await clickText(s, 'Use a different Team ID', { settle: 600 });
  await waitForExpr(s, `!!document.querySelector('#fpl-team-id') && document.querySelector('#fpl-team-id').offsetParent !== null`, { timeout: 8000 });
  await evaluate(s, `(document.querySelector('#fpl-team-id').value = '', 1)`);
  await typeInto(s, '#fpl-team-id', String(teamId));
  await clickText(s, 'Build My Plan', { settle: 900 });
  // The app reopens on the tab it was switched from (Settings), as a manager
  // sees it; the plan is one click away.
  await waitForExpr(s, `/Team ID ${teamId}\\b/.test(document.body.innerText)`, { timeout: 60000 });
  await clickText(s, 'Plan', { settle: 600 });
  return waitPlan(s);
}

export async function run({ base, cdpPort }) {
  const R = [];
  const rec = recorder(R);
  const a = await payloadsFor('inseason', { teamId: TEAM_ID });
  const b = await teamB();
  const bRule = proxyRule(b);
  const s = await newPage(cdpPort);
  try {
    await setViewport(s, 1280, 900);
    // Both teams answered by the stand-in proxy: A's paths by A's rule, B's by B's.
    await interceptNetwork(s, proxyRule(a, { extra: (qs, url) => (qs.startsWith(`entry/${TEAM_B}`) ? bRule(url) : null) }));
    await goto(s, base + APP, { settle: 250 });
    await evaluate(s, `(()=>{
      for (const k of Object.keys(localStorage)) if (/^fplPlanner|^fpl-planner:/.test(k)) localStorage.removeItem(k);
      localStorage.setItem('fplPlannerTeamId', ${JSON.stringify(String(TEAM_ID))});
      return 1;
    })()`);
    await goto(s, base + APP, { settle: 900 });

    /* ---- team A, fresh install ---- */
    await rec('A plans on a fresh install', await waitPlan(s), '', s);
    const a1 = await read(s);
    await rec('A a first plan is compared with nothing', !a1.changed && !a1.unchanged && !a1.rebuilt, JSON.stringify(a1), s);
    const aSaved = await savedPlans(s);
    await rec('A its saved plans are its own one version', aSaved.rows.length === 1, aSaved.rows.join(' | '), s);
    const aLine = aSaved.rows[0];

    /* ---- 1. switch to team B in the same session ---- */
    await rec('1 team B plans after switching in the same session', await switchTo(s, TEAM_B), '', s);
    const b1 = await read(s);
    await rec('1 B is not compared with A: no Plan updated, unchanged or rebuilt notice',
      !b1.changed && !b1.unchanged && !b1.rebuilt, JSON.stringify(b1), s);
    const bSaved = await savedPlans(s);
    await rec('1 B\'s History lists only B\'s plan, never A\'s',
      bSaved.rows.length === 1 && bSaved.rows[0] !== aLine, `B: ${bSaved.rows.join(' | ')} / A: ${aLine}`, s);
    const bLine = bSaved.rows[0];

    /* ---- 2. B recalculated with genuinely different options ---- */
    await clickText(s, 'Settings', { settle: 600 });
    await clickText(s, '8 gameweeks', { settle: 300 });
    await clickText(s, 'Apply and recalculate', { settle: 900 });
    await waitPlan(s);
    await waitForExpr(s, `!!document.querySelector('.fpl-change, .fpl-unchanged')`, { timeout: 30000 });
    const b2 = await read(s);
    await rec('2 B recalculated is compared, and only with B\'s own plan',
      (b2.changed || b2.unchanged) && (!b2.changed || b2.previously === bLine) && b2.previously !== aLine,
      `previously "${b2.previously}" (B was "${bLine}", A was "${aLine}")`, s);
    const bSaved2 = await savedPlans(s);
    await rec('2 B\'s History holds B\'s versions and none of A\'s',
      bSaved2.rows.length >= 1 && !bSaved2.rows.includes(aLine) && bSaved2.rows.includes(bLine), bSaved2.rows.join(' | '), s);

    /* ---- 3. back to A ---- */
    await rec('3 A plans again after switching back', await switchTo(s, TEAM_ID), '', s);
    const a2 = await read(s);
    await rec('3 A is compared with A\'s own history, never with B\'s',
      a2.previously !== bLine && !(bSaved2.rows.includes(a2.previously)) && (!a2.changed || a2.previously === aLine),
      `previously "${a2.previously}" (A was "${aLine}", B was "${bLine}")`, s);
    const aSaved2 = await savedPlans(s);
    await rec('3 A\'s History kept A\'s earlier plan and holds none of B\'s',
      aSaved2.rows.includes(aLine) && !aSaved2.rows.some((r) => bSaved2.rows.includes(r) && r !== aLine), aSaved2.rows.join(' | '), s);

    /* ---- 4. reload on A ---- */
    await goto(s, base + APP, { settle: 900 });
    await rec('4 A plans after a reload', await waitPlan(s), '', s);
    const a3 = await read(s);
    await rec('4 after the reload A is still compared with nothing of B\'s',
      a3.previously !== bLine && !bSaved2.rows.includes(a3.previously || '\\u0000'), `previously "${a3.previously}"`, s);
    const aSaved3 = await savedPlans(s);
    await rec('4 A\'s History survives the reload, A\'s only',
      aSaved3.rows.includes(aLine) && !aSaved3.rows.includes(bLine), aSaved3.rows.join(' | '), s);

    /* ---- 9. demo mode in the same browser ---- */
    await goto(s, `${base}${APP}?demo=1`, { settle: 900 });
    await rec('9 demo mode plans', await waitPlan(s), '', s);
    const d = await read(s);
    await rec('9 demo mode is not compared with a real team', !d.changed && !d.unchanged && !d.rebuilt, JSON.stringify(d), s);
    const dSaved = await savedPlans(s);
    await rec('9 demo mode lists none of the real teams\' saved plans',
      dSaved.empty === true && dSaved.rows.length === 0, `${dSaved.rows.join(' | ')} empty=${dSaved.empty}`, s);

    const errs = errorsOf(s);
    await rec('no console errors across the session', errs.length === 0, errs.slice(0, 2).join(' | '), s);
  } finally {
    await closePage(cdpPort, s);
  }

  await gameweekTransition(cdpPort, base, rec);
  await storageBehaviour(cdpPort, base, rec);
  return R;
}

// The stored value, as the app left it.
const storedHistory = (s) => evaluate(s, `(()=>{ try { return JSON.parse(localStorage.getItem('fplPlannerPlanHistory')); } catch (e) { return 'unparseable'; } })()`);

/* ---- L, C, U. what is stored: legacy history, the team cap, an unknown season ---- */
async function storageBehaviour(cdpPort, base, rec) {
  const a = await payloadsFor('inseason', { teamId: TEAM_ID });
  const others = [7000001, 7000002, 7000003];
  const rules = await Promise.all(others.map(async (id) => [id, proxyRule(await teamB(id))]));
  const extra = (qs, url) => {
    const hit = rules.find(([id]) => qs.startsWith(`entry/${id}`));
    return hit ? hit[1](url) : null;
  };
  const s = await newPage(cdpPort);
  try {
    await setViewport(s, 1280, 900);
    await interceptNetwork(s, proxyRule(a, { extra }));
    await goto(s, base + APP, { settle: 250 });
    // L. History written before 2026-10-25: no team, no season.
    const legacy = { 13: [{ version: 1, computedAt: '2026-10-20T10:00:00Z', reason: 'first-calculation', fingerprint: 'x', plan: { gw: 13, chip: null, transfersOut: [1], transfersIn: [2], transferCount: 1, captain: 1, headline: 'Legacy plan of an unknown team' } }] };
    await evaluate(s, `(()=>{
      for (const k of Object.keys(localStorage)) if (/^fplPlanner|^fpl-planner:/.test(k)) localStorage.removeItem(k);
      localStorage.setItem('fplPlannerTeamId', ${JSON.stringify(String(TEAM_ID))});
      localStorage.setItem('fplPlannerPlanHistory', ${JSON.stringify(JSON.stringify(legacy))});
      return 1;
    })()`);
    await goto(s, base + APP, { settle: 900 });
    await rec('L a team opens over legacy unscoped history', await waitPlan(s), '', s);
    const l = await read(s);
    await rec('L the legacy plan is not compared with', !l.changed && !l.unchanged && !l.rebuilt, JSON.stringify(l), s);
    const lSaved = await savedPlans(s);
    await rec('L the legacy plan is not listed as this team\'s', lSaved.rows.length === 1 && !lSaved.rows.some((r) => /Legacy plan/.test(r)), lSaved.rows.join(' | '), s);
    const lStored = await storedHistory(s);
    await rec('L the first scoped write replaced it', lStored && lStored.v === 2 && lStored['13'] === undefined
      && Object.keys(lStored.scopes || {}).length === 1 && Object.keys(lStored.scopes)[0].startsWith(`${TEAM_ID}|`), JSON.stringify(Object.keys(lStored || {})), s);

    // C. Four teams planned in one session: the three most recently planned are kept.
    for (const id of others) await switchTo(s, id);
    const cStored = await storedHistory(s);
    const keys = Object.keys((cStored && cStored.scopes) || {});
    await rec('C four teams planned: three scopes kept, the latest three',
      keys.length === 3 && others.every((id) => keys.some((k) => k.startsWith(`${id}|`))) && !keys.some((k) => k.startsWith(`${TEAM_ID}|`)),
      keys.join(', '), s);
    const errs = errorsOf(s);
    await rec('L/C no console errors', errs.length === 0, errs.slice(0, 2).join(' | '), s);
  } finally {
    await closePage(cdpPort, s);
  }

  // U. A payload that does not name its season: nothing stored, nothing compared.
  const u = await payloadsFor('inseason', { teamId: TEAM_ID });
  u.bootstrap.game_config = { ...u.bootstrap.game_config, settings: { ...u.bootstrap.game_config.settings, static_content_url: 'https://fantasy.premierleague.com/static/' } };
  const t = await newPage(cdpPort);
  try {
    await setViewport(t, 1280, 900);
    await interceptNetwork(t, proxyRule(u));
    await goto(t, base + APP, { settle: 250 });
    await evaluate(t, `(()=>{
      for (const k of Object.keys(localStorage)) if (/^fplPlanner|^fpl-planner:/.test(k)) localStorage.removeItem(k);
      localStorage.setItem('fplPlannerTeamId', ${JSON.stringify(String(TEAM_ID))});
      return 1;
    })()`);
    await goto(t, base + APP, { settle: 900 });
    await rec('U a season the payload does not name still plans', await waitPlan(t), '', t);
    await clickText(t, 'Settings', { settle: 600 });
    await clickText(t, '8 gameweeks', { settle: 300 });
    await clickText(t, 'Apply and recalculate', { settle: 900 });
    await waitPlan(t);
    const uSaved = await savedPlans(t);
    const uStored = await storedHistory(t);
    const uRead = await read(t);
    await rec('U no history is stored or listed, and nothing is compared',
      uStored === null && uSaved.empty === true && !uRead.changed && !uRead.unchanged, `stored ${JSON.stringify(uStored)}, empty ${uSaved.empty}, ${JSON.stringify(uRead)}`, t);
    const errs = errorsOf(t);
    await rec('U no console errors', errs.length === 0, errs.slice(0, 2).join(' | '), t);
  } finally {
    await closePage(cdpPort, t);
  }
}

/* ---- G. one team, the deadline passes with the page open, the next gameweek is planned ---- */
//
// The comparison is for the same team, season AND gameweek: a plan for GW N+1
// compared with the plan for GW N would say "Plan updated" about two different
// decisions. The page stays open across the deadline, FPL moves on (the stand-in
// proxy starts serving the moved world), and the manager takes the page's own
// "Recalculate" (reactToDeadline -> state.outdated). A recalculation inside one
// gameweek still compares, and the old gameweek's plans stay in History.
async function gameweekTransition(cdpPort, base, rec) {
  const p = await payloadsFor('inseason', { teamId: TEAM_ID });
  const n = p.planGw;
  const deadline = new Date(Date.now() + 2 * 60e3).toISOString();
  // Deadlines a week apart around GW N, in order, as FPL's are (the sample's
  // own dates put GW N-1 after GW N once only GW N is pinned, which no real
  // world has, and which made "the next deadline" GW N-1).
  for (const e of p.bootstrap.events) {
    const at = new Date(Date.parse(deadline) + (e.id - n) * 7 * 24 * 3600e3).toISOString();
    e.deadline_time = at;
    e.deadline_time_epoch = Math.floor(Date.parse(at) / 1000);
  }
  // The world after the deadline: GW N current, N+1 next, and the squad that
  // FPL now serves as the GW N picks (no transfer was made).
  const moved = JSON.parse(JSON.stringify(p.bootstrap));
  for (const e of moved.events) {
    e.is_previous = e.id === n - 1;
    e.is_current = e.id === n;
    e.is_next = e.id === n + 1;
  }
  const picksN = JSON.parse(JSON.stringify(p.picks));
  picksN.active_chip = null;
  picksN.entry_history = { ...picksN.entry_history, event: n, points: 0, event_transfers: 0, event_transfers_cost: 0 };
  let afterDeadline = false;
  const headers = { 'x-fpl-cache': 'hit', 'x-fpl-fetched-at': new Date().toISOString(), 'x-fpl-stale': 'false', 'x-fpl-age-seconds': '0' };
  const s = await newPage(cdpPort);
  try {
    await setViewport(s, 1280, 900);
    await interceptNetwork(s, proxyRule(p, {
      extra: (qs) => {
        if (!afterDeadline) return null;
        if (qs === 'bootstrap-static') return { status: 200, body: moved, headers };
        if (qs === `entry/${TEAM_ID}/event/${n}/picks`) return { status: 200, body: picksN, headers };
        return null;
      },
    }));
    await goto(s, base + APP, { settle: 250 });
    await evaluate(s, `(()=>{
      for (const k of Object.keys(localStorage)) if (/^fplPlanner|^fpl-planner:/.test(k)) localStorage.removeItem(k);
      localStorage.setItem('fplPlannerTeamId', ${JSON.stringify(String(TEAM_ID))});
      return 1;
    })()`);
    await goto(s, base + APP, { settle: 900 });
    await rec(`G GW${n} is planned`, await waitPlan(s), '', s);
    const first = await read(s);
    await rec(`G GW${n}'s first plan is compared with nothing`, !first.changed && !first.unchanged, JSON.stringify(first), s);

    // A legitimate recalculation inside the gameweek is still compared.
    await clickText(s, 'Settings', { settle: 600 });
    await clickText(s, '3 gameweeks', { settle: 300 });
    await clickText(s, 'Apply and recalculate', { settle: 900 });
    await waitPlan(s);
    const same = await waitForExpr(s, `!!document.querySelector('.fpl-change, .fpl-unchanged')`, { timeout: 30000 });
    await rec(`G a recalculation inside GW${n} is still compared with GW${n}'s plan`, same, JSON.stringify(await read(s)), s);
    const nLines = (await savedPlans(s)).rows;

    // The deadline passes with the page open; FPL has moved on.
    afterDeadline = true;
    await evaluate(s, `(()=>{
      const RD = window.__realDate || Date;
      window.__realDate = RD;
      const SHIFT = 10 * 60 * 1000;
      window.Date = new Proxy(RD, {
        construct: (t, a) => (a.length ? new t(...a) : new t(t.now() + SHIFT)),
        get: (t, k) => (k === 'now' ? () => RD.now() + SHIFT : t[k]),
      });
      return 1;
    })()`);
    const outdated = await waitForExpr(s, `[...document.querySelectorAll('.fpl-banner-title')].some((b) => /Plan outdated/.test(b.textContent))`, { timeout: 60000, poll: 500 });
    await rec(`G the page says the GW${n} plan is outdated once the deadline passes`, outdated, '', s);
    await clickText(s, 'Recalculate', { settle: 900 });
    await waitForExpr(s, `/GAMEWEEK ${n + 1}|Gameweek ${n + 1}/i.test((document.querySelector('.fpl-gw-label')||{}).textContent||'')`, { timeout: 60000, poll: 500 });
    await waitPlan(s);
    const next = await read(s);
    const label = await evaluate(s, `(document.querySelector('.fpl-gw-label')||{}).textContent||''`);
    await rec(`G the plan is now for GW${n + 1}`, new RegExp(`${n + 1}`).test(label), label, s);
    await rec(`G GW${n + 1}'s first plan is not compared with GW${n}'s`,
      !next.changed && !next.unchanged && !nLines.includes(next.previously),
      `${JSON.stringify(next)} (GW${n} lines: ${nLines.join(' | ')})`, s);
    const saved = await savedPlans(s);
    await rec(`G History keeps GW${n}'s plans beside GW${n + 1}'s`,
      saved.gameweeks.includes(`Gameweek ${n}`) && saved.gameweeks.includes(`Gameweek ${n + 1}`) && nLines.every((l) => saved.rows.includes(l)),
      `${saved.gameweeks.join(', ')}: ${saved.rows.join(' | ')}`, s);
    const errs = errorsOf(s);
    await rec('G no console errors across the deadline', errs.length === 0, errs.slice(0, 2).join(' | '), s);
  } finally {
    await closePage(cdpPort, s);
  }
}
