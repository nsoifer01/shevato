// Shared fixtures and drivers for the FPL Planner E2E suites.
//
// Adapted from apps/trip-planner/e2e/helpers.mjs, which is the proven pattern in
// this repo: raw CDP through tests/browser/cdp.mjs (no test framework, no npm
// dependency), real coordinate clicks so hit-testing is exercised, waits on real
// application state rather than sleeps, all external traffic intercepted so a
// run is deterministic, and a screenshot written only when a check fails.
//
// THREE THINGS THIS APP NEEDS THAT THE TRIP PLANNER DID NOT
//
// 1. The plan is computed in a Web Worker, so "ready" is not DOMContentLoaded.
//    `waitPlan` polls for the fifteen rendered player cards, which is the first
//    moment a user could act on anything.
//
// 2. Every read goes through the Netlify proxy, so a suite serves the whole
//    lifecycle by INTERCEPTING `/.netlify/functions/fpl?path=...`. That is what
//    lets a browser test stand in pre-season, at a passed deadline, or midway
//    through a gameweek, none of which `?demo=1` can express.
//
// 3. The app state that matters (which squad you are looking at) lives in a
//    module-scoped object, so tests read it the way a user does: off the DOM.
import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  newPage, goto, evaluate, waitForExpr, clickSel, setViewport, screenshot,
  sleep, cleanErrors, interceptNetwork,
} from '../../../tests/browser/cdp.mjs';

export const APP = '/apps/fpl-planner/';
export const TEAM_ID = 1234567;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
export const ART_DIR = path.join(REPO, '.screenshots', 'e2e-fpl-planner');

/* ------------------------------------------------------------- recording */

export function recorder(R) {
  return async (name, pass, detail = '', s = null) => {
    R.push({ name, pass: !!pass, detail: detail ? String(detail).slice(0, 200) : '' });
    if (!pass && s) {
      try {
        await mkdir(ART_DIR, { recursive: true });
        const file = path.join(ART_DIR, name.replace(/[^a-z0-9_-]+/gi, '_').slice(0, 80) + '.png');
        await screenshot(s, file);
        const last = R[R.length - 1];
        last.detail = (last.detail ? last.detail + ' ' : '') + `[shot: ${path.relative(REPO, file)}]`;
      } catch { /* a failed artifact never masks the failure itself */ }
    }
  };
}

/* --------------------------------------------------------------- payloads */

// The committed sample dataset is the source of every fixture here: it is small,
// it is already in the repo, and it carries real payload shapes including a
// squad whose purchase prices differ from current prices, an injured player, a
// blank gameweek and a double. Each lifecycle state is a MUTATION of it, so a
// suite never depends on a hand-written payload drifting from the real one.
let cache = null;
async function sampleFiles() {
  if (cache) return cache;
  const names = ['meta', 'bootstrap', 'fixtures', 'entry', 'entry-history', 'entry-transfers', 'entry-picks'];
  const out = {};
  for (const n of names) {
    out[n] = JSON.parse(await readFile(path.join(HERE, '..', 'data', 'sample', `${n}.json`), 'utf8'));
  }
  const { assembleSampleBundle } = await import('../js/data/sample.js');
  // expandTable() restores the column-packed players and fixtures to the exact
  // upstream shape, which is what the proxy would return.
  cache = assembleSampleBundle(out);
  return cache;
}

const clone = (v) => JSON.parse(JSON.stringify(v));

// The gameweek the sample squad belongs to, and the one after it.
export async function sampleGws() {
  const b = await sampleFiles();
  return { current: b.currentEvent, plan: b.planEvent };
}

/* ------------------------------------------------------------- lifecycle */

// Every state the audit said the app had to survive, expressed as a payload set.
// A suite names one; nothing else in the test has to know how it is built.
export const STATES = [
  'preseason',        // no event current, GW1 next, picks 404 for everyone
  'deadline-soon',    // pre-season, but the GW1 deadline is minutes away
  'gw1-locked',       // deadline passed, GW1 current, nothing kicked off yet
  'gw1-live',         // some GW1 fixtures finished, the rest not
  'gw1-finished',     // every GW1 fixture played, event finished + data_checked
  'gw2-window',       // GW1 done and a real transfer already made for GW2
  'inseason',         // the sample dataset as it ships (mid-season, GW13)
];

// Build the six proxy payloads for a lifecycle state.
//
// `now` is the wall clock the page will be told to believe, so a deadline can
// sit in the future or the past without the suite waiting for real time.
export async function payloadsFor(state, { teamId = TEAM_ID } = {}) {
  const b = await sampleFiles();
  const bootstrap = clone(b.bootstrap);
  const fixtures = clone(b.fixtures);
  const entry = clone(b.entry);
  const history = clone(b.history);
  const transfers = clone(b.transfers);
  const picks = clone(b.picks);

  const events = bootstrap.events;
  const first = events[0];
  const byId = (id) => events.find((e) => e.id === id);
  const clearEvents = () => {
    for (const e of events) {
      e.is_current = false;
      e.is_next = false;
      e.is_previous = false;
      e.finished = false;
      e.data_checked = false;
    }
  };
  const clearFixtures = () => {
    for (const f of fixtures) {
      f.finished = false;
      f.finished_provisional = false;
      f.started = false;
      f.team_h_score = null;
      f.team_a_score = null;
    }
  };
  const finishGw = (gw, { provisional = false } = {}) => {
    for (const f of fixtures.filter((x) => x.event === gw)) {
      f.started = true;
      f.finished = !provisional;
      f.finished_provisional = true;
      if (f.team_h_score === null) f.team_h_score = 1;
      if (f.team_a_score === null) f.team_a_score = 0;
    }
  };

  const gw1 = first.id;
  let planGw = gw1;
  let picksGw = null;
  let deadlineOffsetMs = 7 * 24 * 3600 * 1000;

  if (state === 'preseason' || state === 'deadline-soon') {
    clearEvents();
    clearFixtures();
    first.is_next = true;
    history.current = [];
    transfers.length = 0;
    picksGw = null;                       // picks 404 for every gameweek
    deadlineOffsetMs = state === 'deadline-soon' ? 4 * 60 * 1000 : deadlineOffsetMs;
  } else if (state === 'inseason') {
    picksGw = b.currentEvent;
    planGw = b.planEvent;
    deadlineOffsetMs = 3 * 24 * 3600 * 1000;
  } else {
    // GW1 states: the season has started and the squad is the sample fifteen.
    clearEvents();
    clearFixtures();
    const e1 = byId(gw1);
    e1.is_current = true;
    const e2 = events[1];
    if (e2) e2.is_next = true;
    picksGw = gw1;
    planGw = e2 ? e2.id : gw1;
    deadlineOffsetMs = -30 * 60 * 1000;   // GW1 deadline is behind us

    if (state === 'gw1-live') finishGw(gw1, { provisional: true });
    if (state === 'gw1-finished' || state === 'gw2-window') {
      finishGw(gw1);
      e1.finished = true;
      e1.data_checked = true;
      history.current = [{
        event: gw1, points: 62, total_points: 62, rank: 1500000, overall_rank: 1500000,
        bank: picks.entry_history ? picks.entry_history.bank : 0,
        value: picks.entry_history ? picks.entry_history.value : 1000,
        event_transfers: 0, event_transfers_cost: 0, points_on_bench: 4,
      }];
    }
  }

  // A real transfer already made for the gameweek being planned. `picks` stays
  // frozen at the GW1 deadline exactly as FPL serves it, and only the transfers
  // endpoint knows about the move: the shape the planner has to reconcile.
  let madeTransfer = null;
  if (state === 'gw2-window') {
    const outPick = picks.picks.find((p) => p.position <= 11 && p.element);
    const outId = outPick.element;
    const outPlayer = bootstrap.elements.find((e) => e.id === outId);
    const owned = new Set(picks.picks.map((p) => p.element));
    const replacement = bootstrap.elements.find((e) =>
      e.element_type === outPlayer.element_type && !owned.has(e.id) && e.now_cost <= outPlayer.now_cost);
    madeTransfer = { outId, inId: replacement.id, gw: planGw };
    transfers.length = 0;
    transfers.push({
      element_in: replacement.id,
      element_in_cost: replacement.now_cost,
      element_out: outId,
      element_out_cost: outPlayer.now_cost,
      entry: teamId,
      event: planGw,
      time: '2026-08-25T10:00:00Z',
    });
  }

  // Pin the GW1 deadline relative to the clock the page will run on.
  const deadlineIso = new Date(Date.now() + deadlineOffsetMs).toISOString();
  const target = byId(picksGw === null ? gw1 : (state === 'inseason' ? b.planEvent : planGw));
  if (target) {
    target.deadline_time = deadlineIso;
    target.deadline_time_epoch = Math.floor(Date.parse(deadlineIso) / 1000);
  }
  if (state === 'preseason' || state === 'deadline-soon') {
    first.deadline_time = deadlineIso;
    first.deadline_time_epoch = Math.floor(Date.parse(deadlineIso) / 1000);
  }

  return { bootstrap, fixtures, entry, history, transfers, picks, picksGw, planGw, madeTransfer, teamId };
}

// Turn a payload set into an interception rule for the proxy. Anything the app
// asks for that this state does not have comes back 404, which is exactly what
// FPL does with picks before a gameweek is played.
export function proxyRule(p, { fail = null, stale = false, extra = null } = {}) {
  const map = new Map([
    ['bootstrap-static', p.bootstrap],
    ['fixtures', p.fixtures],
    [`entry/${p.teamId}`, p.entry],
    [`entry/${p.teamId}/history`, p.history],
    [`entry/${p.teamId}/transfers`, p.transfers],
  ]);
  if (p.picksGw !== null && p.picksGw !== undefined) {
    map.set(`entry/${p.teamId}/event/${p.picksGw}/picks`, p.picks);
  }

  return (url) => {
    if (!/\/\.netlify\/functions\/fpl\?/.test(url)) {
      // Block anything else that leaves the origin so a run cannot depend on it.
      return /^https?:\/\/(127\.0\.0\.1|localhost)/.test(url) ? null : 'fail';
    }
    const qs = decodeURIComponent((url.split('path=')[1] || '').split('&')[0]);
    if (extra) {
      const v = extra(qs, url);
      if (v !== undefined && v !== null) return v;
    }
    if (fail) {
      const v = fail(qs);
      if (v !== undefined && v !== null) return v;
    }
    // Every response carries the headers the real function stamps. The 404 is
    // the one that matters: js/data/api.js reads a 404 WITHOUT `x-fpl-cache` as
    // "this static server has no Netlify function", not as "FPL has no data
    // here", so a bare 404 made the app report the proxy missing instead of
    // exercising the missing-picks path.
    const headers = {
      'x-fpl-cache': map.has(qs) ? 'hit' : 'miss',
      'x-fpl-fetched-at': new Date().toISOString(),
      'x-fpl-stale': String(!!stale),
      'x-fpl-age-seconds': '0',
    };
    if (!map.has(qs)) return { status: 404, body: { error: 'not_found' }, headers };
    return { status: 200, body: map.get(qs), headers };
  };
}

/* ------------------------------------------------------------- page setup */

// Seeds the team id, installs the lifecycle payloads, and waits for a plan.
//
// `clockOffsetMs` shifts the page's Date so a suite can stand either side of a
// deadline without waiting. It is installed before any app script runs.
export async function openPlanner(cdpPort, base, {
  state = 'inseason', viewport = [1280, 900], teamId = TEAM_ID, demo = false,
  clockOffsetMs = 0, extra = null, fail = null, stale = false, waitFor = 'plan',
} = {}) {
  const s = await newPage(cdpPort);
  s.fplState = state;
  await setViewport(s, viewport[0], viewport[1], viewport[0] < 700);

  const p = await payloadsFor(state, { teamId });
  s.payloads = p;
  if (!demo) await interceptNetwork(s, proxyRule(p, { fail, stale, extra }));

  // Land on the origin first so localStorage is writable, then seed and reload.
  await goto(s, base + APP, { settle: 250 });
  await evaluate(s, `(()=>{ try{
    for (const k of Object.keys(localStorage)) if (/^fplPlanner|^fpl-planner:/.test(k)) localStorage.removeItem(k);
    ${demo ? '' : `localStorage.setItem('fplPlannerTeamId', ${JSON.stringify(String(teamId))});`}
  } catch(e){} return 1 })()`);

  if (clockOffsetMs) await installClockShift(s, clockOffsetMs);
  await goto(s, base + APP + (demo ? '?demo=1' : ''), { settle: 400 });

  if (waitFor === 'intro') {
    await waitPreseasonIntro(s);
    return s;
  }
  if (waitFor === 'plan') {
    // Pre-season there is no squad to import, so the app opens on the intro and
    // the user builds an opening fifteen. That IS the pre-season entry point,
    // so the driver walks it rather than pretending a dashboard appears.
    const built = await waitForExpr(s, `document.querySelectorAll('.fpl-pp-meta').length >= 15`, { timeout: 8000 });
    if (!built) {
      const onIntro = await waitPreseasonIntro(s, 20000);
      if (onIntro) await clickText(s, 'Build the optimal 15', { settle: 600 });
    }
    await waitPlan(s);
  }
  return s;
}

// Shift the page clock. Installed as a document-start script so the app never
// sees the real time, which is what makes a deadline crossing testable.
export async function installClockShift(s, offsetMs) {
  const src = `(()=>{const O=${offsetMs};const RD=Date;
    function D(...a){ return a.length? new RD(...a) : new RD(RD.now()+O); }
    D.now=()=>RD.now()+O; D.parse=RD.parse; D.UTC=RD.UTC; D.prototype=RD.prototype;
    window.Date=new Proxy(RD,{construct:(t,a)=>a.length? new t(...a) : new t(t.now()+O), get:(t,k)=> k==='now'? ()=>t.now()+O : t[k]});
  })()`;
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: src });
}

// The plan is ready when the squad is on screen. Fifteen player cards is the
// first instant a user could act, and it is what the worker produces.
export const waitPlan = (s, timeout = 60000) =>
  waitForExpr(s, `document.querySelectorAll('.fpl-pp-meta').length >= 15`, { timeout });

export const waitPreseasonIntro = (s, timeout = 30000) =>
  waitForExpr(s, `!!document.querySelector('.fpl-btn') && /season has not started|opening 15/i.test(document.body.textContent)`, { timeout });

/* ---------------------------------------------------------------- readers */

// Which of the three squads is on screen, read the way a user reads it.
export const activeView = (s) => evaluate(s, `(()=>{
  const seg = document.querySelector('.fpl-card-tools .fpl-seg');
  if (!seg) return null;
  const on = [...seg.children].find(b => b.classList.contains('is-on'));
  return on ? on.textContent.trim() : null;
})()`);

export const viewTabs = (s) => evaluate(s, `(()=>{
  const seg = document.querySelector('.fpl-card-tools .fpl-seg');
  return seg ? [...seg.children].map(b => b.textContent.trim()) : [];
})()`);

export const scenarioRead = (s) => evaluate(s, `(()=>{
  const q=(x)=>document.querySelector(x), qa=(x)=>[...document.querySelectorAll(x)];
  const t=(x)=>{const e=q(x);return e?e.textContent.trim():null;};
  return {
    flag: t('.fpl-scenario-flag'),
    edited: !!q('.fpl-scenario-flag.is-edited'),
    verdict: t('.fpl-verdict'),
    // Scoped to the sandbox: the planner-from-scenario card reuses the same
    // class for the moves IT suggests, and counting both conflates the
    // manager's edits with the recommendation about them.
    moves: qa('.fpl-sandbox .fpl-moves li').map(l=>l.textContent.trim()),
    cmp: qa('.fpl-cmp').map(c=>({
      k:c.querySelector('.fpl-cmp-k').textContent.trim(),
      before:c.querySelector('.fpl-cmp-before').textContent.trim(),
      after:c.querySelector('.fpl-cmp-after').textContent.trim(),
    })),
    xi: qa('.fpl-pitch-edit .fpl-pp-edit').map(c=>c.querySelector('.fpl-pp-name').textContent.trim()),
    bench: qa('.fpl-bench .fpl-pp-edit').map(c=>c.querySelector('.fpl-pp-name').textContent.trim()),
    captain: (qa('.fpl-pp-edit').find(c=>c.querySelector('.fpl-pp-arm.is-c'))||{querySelector:()=>null}).querySelector
      ? (qa('.fpl-pp-edit').find(c=>c.querySelector('.fpl-pp-arm.is-c'))||null) && (qa('.fpl-pp-edit').find(c=>c.querySelector('.fpl-pp-arm.is-c'))).querySelector('.fpl-pp-name').textContent.trim()
      : null,
    vice: (()=>{const c=qa('.fpl-pp-edit').find(x=>x.querySelector('.fpl-pp-arm.is-v'));return c?c.querySelector('.fpl-pp-name').textContent.trim():null})(),
    actionWho: t('.fpl-actionbar-who'),
    actions: qa('.fpl-actionbar-actions .fpl-btn').map(b=>b.textContent.trim()),
    picker: !!q('.fpl-picker'),
    detailCards: qa('.fpl-pp-detail').length,
    scenarioPlan: !!q('.fpl-scenario-plan'),
    drawer: !!q('.fpl-dw-overlay'),
  };
})()`);

export const heroRead = (s) => evaluate(s, `(()=>{
  const q=(x)=>document.querySelector(x);
  const t=(x)=>{const e=q(x);return e?e.textContent.trim():null;};
  return {
    gw: t('.fpl-gw-label'),
    deadline: t('.fpl-deadline'),
    headline: t('.fpl-hero-headline'),
    outdated: /Plan outdated/i.test(document.body.textContent),
    banners: [...document.querySelectorAll('.fpl-banner')].map(b=>b.textContent.trim().slice(0,120)),
  };
})()`);

/* ---------------------------------------------------------------- drivers */

export async function openScenario(s) {
  const ok = await clickText(s, 'My scenario');
  await sleep(450);
  return ok;
}

// Clicks a rendered control by its exact visible label.
export async function clickText(s, label, { settle = 450 } = {}) {
  const idx = await evaluate(s, `(()=>{
    const els=[...document.querySelectorAll('button,.fpl-btn')];
    return els.findIndex(e=>e.textContent.trim()===${JSON.stringify(label)});
  })()`);
  if (idx === null || idx < 0) return false;
  const ok = await clickSel(s, 'button,.fpl-btn', { nth: idx, settle });
  return ok;
}

export async function clickPlayer(s, name, { settle = 450 } = {}) {
  const idx = await evaluate(s, `[...document.querySelectorAll('.fpl-pp-edit')]
    .findIndex(c=>c.querySelector('.fpl-pp-name').textContent.trim()===${JSON.stringify(name)})`);
  if (idx === null || idx < 0) return false;
  return clickSel(s, '.fpl-pp-edit', { nth: idx, settle });
}

// Transfer the named player out and take the first replacement that is not
// blocked, returning who came in.
export async function transferOut(s, name) {
  if (!await clickPlayer(s, name)) return null;
  if (!await clickText(s, 'Transfer out')) return null;
  await waitForExpr(s, `!!document.querySelector('.fpl-cb-list li')`, { timeout: 8000 });
  const pick = await evaluate(s, `(()=>{
    const rows=[...document.querySelectorAll('.fpl-cb-list li')];
    const i=rows.findIndex(r=>!/He costs|You would have|Already in your squad/i.test(r.textContent));
    return i<0?null:{i, label: rows[i].querySelector('.fpl-cb-name').textContent.trim()};
  })()`);
  if (!pick) return null;
  await clickSel(s, '.fpl-cb-list li', { nth: pick.i, settle: 800 });
  return pick.label;
}

export const errorsOf = cleanErrors;
export { sleep, evaluate, waitForExpr, clickSel, screenshot, setViewport };
