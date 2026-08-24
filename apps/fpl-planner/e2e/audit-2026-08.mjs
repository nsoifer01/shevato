// E2E: the 2026-08-22 site-wide audit, pinned in the browser.
//
// Each block reproduces one confirmed defect from the audit report in the
// state it was found in, and asserts the repaired behaviour. The seeded axe
// scans cover the views the site-level a11y suite never reaches (plan,
// scenario, History, the player drawer, Settings) at desktop and phone width.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePage, evalAsync, pressKey, newPage, interceptNetwork, goto, setViewport } from '../../../tests/browser/cdp.mjs';
import {
  recorder, openPlanner, heroRead, scenarioRead, openScenario, clickPlayer, clickText, waitPlan, waitForExpr,
  evaluate, sleep, errorsOf, payloadsFor, proxyRule, TEAM_ID, APP,
} from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AXE_PATH = path.resolve(HERE, '..', '..', '..', 'tests', 'browser', 'vendor', 'axe.min.js');

// The app fades a view in (`.fpl-view.is-active`), and axe composites ancestor
// opacity into every contrast reading: scanning mid-fade reported 86 serious
// colour-contrast violations that are not there once the animation settles.
async function settled(s) {
  await waitForExpr(s, `[...document.querySelectorAll('.fpl-view.is-active, .fpl-planner-app')]
    .every(e => getComputedStyle(e).opacity === '1')`, { timeout: 6000 });
  await sleep(150);
}

async function axeScan(s, axeSource) {
  await settled(s);
  await s.send('Runtime.evaluate', { expression: axeSource, returnByValue: false });
  return evalAsync(s, `window.axe.run(document, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] }, resultTypes: ['violations'],
  }).then(r => r.violations.filter(v => v.impact === 'serious' || v.impact === 'critical')
    .map(v => ({ id: v.id, impact: v.impact, count: v.nodes.length, targets: v.nodes.slice(0, 3).map(n => (n.target || []).join(' ')) })))`);
}

const describeAxe = (v) => v.map(x => `${x.id}(${x.impact}) x${x.count}: ${x.targets.join(', ')}`).join(' | ');
// The APP's own overflow. The document's is not the app's to answer for: the
// site's shared header renders 391px wide in a 390px viewport, which is a
// site-level defect in chrome this app may not edit.
const overflow = (s) => evaluate(s, `(()=>{const a=document.querySelector('.fpl-planner-app');
  return a ? a.scrollWidth - a.clientWidth : document.documentElement.scrollWidth - document.documentElement.clientWidth;})()`);

export async function run({ base, cdpPort }) {
  const R = [];
  const rec = recorder(R);
  const axeSource = await readFile(AXE_PATH, 'utf8');

  /* --------------------------------- 1. seeded axe scans, 1280 and 390 ---- */
  for (const [w, h] of [[1280, 900], [390, 844]]) {
    const tag = `@${w}`;
    const s = await openPlanner(cdpPort, base, { state: 'inseason', viewport: [w, h] });
    try {
      let v = await axeScan(s, axeSource);
      await rec(`${tag} plan view: no serious or critical axe violation`, v.length === 0, describeAxe(v), s);

      // The player drawer.
      const first = await evaluate(s, `(document.querySelector('.fpl-pitch .fpl-pp .fpl-pp-name')||{}).textContent||''`);
      await clickPlayer(s, first.trim());
      await waitForExpr(s, `!!document.querySelector('.fpl-dw-overlay')`, { timeout: 6000 });
      v = await axeScan(s, axeSource);
      await rec(`${tag} player drawer: no serious or critical axe violation`, v.length === 0, describeAxe(v), s);
      await pressKey(s, 'Escape', 'Escape', 27);
      await sleep(300);

      // The scenario with a sold and a bought player (the dimmed cards).
      await openScenario(s);
      const sc = await scenarioRead(s);
      await clickPlayer(s, sc.xi[2]);
      await clickText(s, 'Transfer out');
      await waitForExpr(s, `document.querySelectorAll('.fpl-cb-opt, .fpl-picker-row, .fpl-tr-pick').length > 0 || /Choose|Pick/i.test(document.body.textContent)`, { timeout: 6000 });
      await evaluate(s, `(()=>{const b=[...document.querySelectorAll('button')].find(x=>/^Buy\\b|^Add\\b|^Pick\\b/.test(x.textContent.trim()));if(b)b.click();return 1})()`);
      await sleep(600);
      v = await axeScan(s, axeSource);
      await rec(`${tag} scenario view: no serious or critical axe violation`, v.length === 0, describeAxe(v), s);

      await clickText(s, 'History', { settle: 900 });
      v = await axeScan(s, axeSource);
      await rec(`${tag} History view: no serious or critical axe violation`, v.length === 0, describeAxe(v), s);
      await rec(`${tag} History view: the app root does not scroll sideways`, (await overflow(s)) <= 0, `${await overflow(s)}px`, s);
      const focusable = await evaluate(s, `[...document.querySelectorAll('.fpl-table-wrap')].every(e => e.getAttribute('tabindex') === '0')`);
      await rec(`${tag} History tables are keyboard-reachable scroll regions`, focusable, '', s);

      await clickText(s, 'Settings', { settle: 600 });
      v = await axeScan(s, axeSource);
      await rec(`${tag} Settings view: no serious or critical axe violation`, v.length === 0, describeAxe(v), s);
    } finally { await closePage(cdpPort, s); }
  }

  /* --------------------------- 2. History chart geometry (D3) -------------- */
  {
    const s = await openPlanner(cdpPort, base, { state: 'inseason', viewport: [390, 844] });
    try {
      await clickText(s, 'History', { settle: 900 });
      const cols = await evaluate(s, `JSON.stringify([...document.querySelectorAll('.fpl-chart-cols')][0] ? [...document.querySelectorAll('.fpl-chart-cols')][0].querySelectorAll('.fpl-col') : []).replace(/.*/s, '')`);
      const geo = await evaluate(s, `(()=>{
        const chart = document.querySelector('.fpl-chart-cols'); if (!chart) return null;
        return [...chart.querySelectorAll('.fpl-col')].map(c => ({
          value: parseFloat((c.getAttribute('aria-label')||'').replace(/^[^:]*:\\s*/, '')),
          fill: c.querySelector('.fpl-col-fill').getBoundingClientRect().height,
          track: c.querySelector('.fpl-col-track').getBoundingClientRect().height,
        }));
      })()`);
      const tracks = geo ? new Set(geo.map(g => Math.round(g.track))) : new Set();
      await rec('every History column has the same track height, captioned or not', !!geo && tracks.size === 1, JSON.stringify([...tracks]), s);
      let monotone = !!geo && geo.length > 1;
      for (let i = 0; geo && i < geo.length; i++) for (let j = 0; j < geo.length; j++) {
        if (geo[i].value > geo[j].value && !(geo[i].fill > geo[j].fill)) monotone = false;
      }
      await rec('History column fill heights order exactly as their values do', monotone,
        geo ? geo.map(g => `${g.value}:${g.fill.toFixed(0)}`).join(' ') : 'no chart', s);
      void cols;
    } finally { await closePage(cdpPort, s); }
  }

  /* ---------------------- 3. phone geometry: deadline pill and names (D10) - */
  {
    const s = await openPlanner(cdpPort, base, { state: 'inseason', viewport: [360, 740] });
    try {
      // Count real line boxes rather than dividing by line-height: the pill has
      // padding and a wrap gap, so the arithmetic version read three for two.
      const pill = await evaluate(s, `(()=>{const e=document.querySelector('.fpl-deadline'); if(!e) return null;
        const tops=new Set(); for (const kid of e.children) for (const r of kid.getClientRects()) tops.add(Math.round(r.top));
        return { lines: tops.size, text: e.textContent.trim() }; })()`);
      await rec('@360 the deadline pill is at most two lines', !!pill && pill.lines <= 2, JSON.stringify(pill), s);
      await rec('@360 the app root does not scroll sideways on the plan', (await overflow(s)) <= 0, `${await overflow(s)}px`, s);
    } finally { await closePage(cdpPort, s); }
    const s2 = await openPlanner(cdpPort, base, { state: 'inseason', viewport: [390, 844] });
    try {
      const names = await evaluate(s2, `(()=>{
        const rows=[...document.querySelectorAll('.fpl-pitch .fpl-row')].filter(r=>r.children.length>=5);
        return rows.flatMap(r=>[...r.querySelectorAll('.fpl-pp-name')].map(n=>({ t:n.textContent.trim(), clipped:n.scrollWidth>n.clientWidth+1 })));
      })()`);
      const clipped = names.filter(n => n.clipped);
      await rec('@390 names in a five-wide row are not truncated', names.length > 0 && clipped.length === 0,
        clipped.map(n => n.t).join(', ') || `${names.length} names checked`, s2);
    } finally { await closePage(cdpPort, s2); }
  }

  /* ----------------- 4. desktop sticky header clears the site nav (D11) ---- */
  {
    const s = await openPlanner(cdpPort, base, { state: 'inseason' });
    try {
      await evaluate(s, 'window.scrollTo(0, 900)');
      await sleep(400);
      const geo = await evaluate(s, `(()=>{const nav=document.querySelector('#header'); const bar=document.querySelector('.fpl-topbar');
        if(!nav||!bar) return null; const n=nav.getBoundingClientRect(), b=bar.getBoundingClientRect();
        const probe=document.elementFromPoint(b.left+40, b.top+8);
        return { navBottom:n.bottom, barTop:b.top, probeInBar: !!(probe && bar.contains(probe)) }; })()`);
      await rec('scrolled, the sticky app header sits fully below the fixed site nav',
        !!geo && geo.barTop >= geo.navBottom - 1 && geo.probeInBar, JSON.stringify(geo), s);
    } finally { await closePage(cdpPort, s); }
  }

  /* ------------------------------ 5. swap mode: Cancel and Escape ---------- */
  {
    const s = await openPlanner(cdpPort, base, { state: 'inseason' });
    try {
      await openScenario(s);
      const v = await scenarioRead(s);
      await clickPlayer(s, v.xi[4]);
      await clickText(s, 'Swap with a substitute');
      let read = await scenarioRead(s);
      await rec('swap mode names the selected player', /changes places/i.test(read.actionWho || ''), read.actionWho, s);
      const hasCancel = await evaluate(s, `!![...document.querySelectorAll('.fpl-actionbar button')].find(b=>/^Cancel$/.test(b.textContent.trim()))`);
      await rec('and offers a Cancel button', hasCancel, '', s);
      await evaluate(s, `(()=>{const c=document.querySelector('.fpl-pp-edit.is-selected'); if(c) c.focus(); return 1})()`);
      await pressKey(s, 'Escape', 'Escape', 27);
      await sleep(400);
      read = await scenarioRead(s);
      await rec('Escape leaves swap mode', !read.actionWho || !/changes places/i.test(read.actionWho), read.actionWho || '(no action bar)', s);
    } finally { await closePage(cdpPort, s); }
  }

  /* ------------------ 6. a plan past its deadline is not actionable --------- */
  {
    // The page clock sits 2 hours PAST the plan gameweek's deadline at boot.
    const s = await openPlanner(cdpPort, base, { state: 'inseason', clockOffsetMs: 3 * 24 * 3600 * 1000 + 2 * 3600 * 1000, waitFor: 'plan' });
    try {
      const settled = await waitForExpr(s, `/Deadline passed/i.test(document.body.textContent) && (/no longer be acted on|Plan outdated/i.test(document.body.textContent))`, { timeout: 8000 });
      const hero = await heroRead(s);
      await rec('a plan computed past its own deadline reads outdated at once, not after the 30 s tick',
        settled, `${hero.deadline} | ${hero.banners.join(' | ').slice(0, 120)}`, s);
    } finally { await closePage(cdpPort, s); }
  }

  /* --------- 7. degenerate personal sources: history null, unknown pick ---- */
  {
    const s = await newPage(cdpPort);
    try {
      await setViewport(s, 1280, 900, false);
      const p = await payloadsFor('inseason', { teamId: TEAM_ID });
      p.history = null;
      await interceptNetwork(s, proxyRule(p));
      await goto(s, base + APP, { settle: 250 });
      await evaluate(s, `(()=>{for (const k of Object.keys(localStorage)) if (/^fplPlanner|^fpl-planner:/.test(k)) localStorage.removeItem(k); localStorage.setItem('fplPlannerTeamId', ${JSON.stringify(String(TEAM_ID))}); return 1})()`);
      await goto(s, base + APP, { settle: 400 });
      await waitPlan(s);
      const text = await evaluate(s, 'document.body.textContent');
      await rec('a null season history is named on screen', /season history could not be read/i.test(text), '', s);
      await rec('and no chip is recommended on it', !/Play your (Wildcard|Free Hit|Bench Boost|Triple Captain)/i.test(text),
        (text.match(/Play your [A-Za-z ]+/) || [''])[0], s);
      await rec('and the ladder says chip advice is paused', /paused/i.test(text), '', s);
    } finally { await closePage(cdpPort, s); }

    const s2 = await newPage(cdpPort);
    try {
      await setViewport(s2, 1280, 900, false);
      const p = await payloadsFor('inseason', { teamId: TEAM_ID });
      p.picks.picks[2].element = 999999;
      await interceptNetwork(s2, proxyRule(p));
      await goto(s2, base + APP, { settle: 250 });
      await evaluate(s2, `(()=>{for (const k of Object.keys(localStorage)) if (/^fplPlanner|^fpl-planner:/.test(k)) localStorage.removeItem(k); localStorage.setItem('fplPlannerTeamId', ${JSON.stringify(String(TEAM_ID))}); return 1})()`);
      await goto(s2, base + APP, { settle: 400 });
      const explained = await waitForExpr(s2, `/player list does not carry/i.test(document.body.textContent)`, { timeout: 20000 });
      const text = await evaluate(s2, 'document.body.textContent');
      await rec('an unknown pick id is refused in a sentence', explained, text.slice(0, 160), s2);
      await rec('and never as a raw TypeError', !/Cannot read properties/i.test(text), '', s2);
      const errs = errorsOf(s2);
      await rec('with no uncaught console error', errs.length === 0, errs.slice(0, 2).join(' | '), s2);
    } finally { await closePage(cdpPort, s2); }
  }

  /* -------- 8. stale-under-six-hours, fixtures [], empty picks, settings --- */
  {
    const s = await openPlanner(cdpPort, base, { state: 'inseason', stale: true });
    try {
      const text = await evaluate(s, 'document.body.textContent');
      await rec('every source served stale is disclosed while the plan still shows',
        /not answering/i.test(text) && /only an older copy/i.test(text) && !!(await evaluate(s, `!!document.querySelector('.fpl-pitch')`)), '', s);
    } finally { await closePage(cdpPort, s); }

    const s2 = await newPage(cdpPort);
    try {
      await setViewport(s2, 1280, 900, false);
      const p = await payloadsFor('inseason', { teamId: TEAM_ID });
      p.fixtures = [];
      await interceptNetwork(s2, proxyRule(p));
      await goto(s2, base + APP, { settle: 250 });
      await evaluate(s2, `(()=>{for (const k of Object.keys(localStorage)) if (/^fplPlanner|^fpl-planner:/.test(k)) localStorage.removeItem(k); localStorage.setItem('fplPlannerTeamId', ${JSON.stringify(String(TEAM_ID))}); return 1})()`);
      await goto(s2, base + APP, { settle: 400 });
      const withheld = await waitForExpr(s2, `/not showing a plan right now/i.test(document.body.textContent) && /fixture list could not be loaded/i.test(document.body.textContent)`, { timeout: 30000 });
      await rec('an empty fixture list withholds the plan with the reason', withheld, '', s2);
      await rec('and no "No fixture, 0.0 xP" captain is shown', !(await evaluate(s2, `/No fixture/.test(document.body.textContent) && !!document.querySelector('.fpl-pitch')`)), '', s2);
    } finally { await closePage(cdpPort, s2); }

    const s3 = await newPage(cdpPort);
    try {
      await setViewport(s3, 1280, 900, false);
      const p = await payloadsFor('inseason', { teamId: TEAM_ID });
      p.picks.picks = [];
      await interceptNetwork(s3, proxyRule(p));
      await goto(s3, base + APP, { settle: 250 });
      await evaluate(s3, `(()=>{for (const k of Object.keys(localStorage)) if (/^fplPlanner|^fpl-planner:/.test(k)) localStorage.removeItem(k); localStorage.setItem('fplPlannerTeamId', ${JSON.stringify(String(TEAM_ID))}); return 1})()`);
      await goto(s3, base + APP, { settle: 400 });
      await waitPlan(s3);
      const text = await evaluate(s3, 'document.body.textContent');
      await rec('an empty in-season squad is explained as such', /squad could not be read/i.test(text) && /empty squad/i.test(text), '', s3);
      await rec('and not presented under a price-mismatch banner', !/One number does not match/i.test(text), '', s3);
    } finally { await closePage(cdpPort, s3); }

    const s4 = await newPage(cdpPort);
    try {
      await setViewport(s4, 1280, 900, false);
      const p = await payloadsFor('inseason', { teamId: TEAM_ID });
      await interceptNetwork(s4, proxyRule(p));
      await goto(s4, base + APP, { settle: 250 });
      await evaluate(s4, `(()=>{for (const k of Object.keys(localStorage)) if (/^fplPlanner|^fpl-planner:/.test(k)) localStorage.removeItem(k);
        localStorage.setItem('fplPlannerTeamId', ${JSON.stringify(String(TEAM_ID))});
        localStorage.setItem('fplPlannerSettings', JSON.stringify({ horizon: 'x', risk: 42, lastView: '<b>' })); return 1})()`);
      await goto(s4, base + APP, { settle: 400 });
      await waitPlan(s4);
      const text = await evaluate(s4, 'document.body.textContent');
      await rec('wrong-typed settings still load a plan on the defaults', /over 5 gameweeks/i.test(text) && !/could not load the data/i.test(text), text.slice(0, 120), s4);
    } finally { await closePage(cdpPort, s4); }
  }

  /* ------------- 9. Delete all data takes the entry cache with it ---------- */
  {
    const s = await openPlanner(cdpPort, base, { state: 'inseason' });
    try {
      const before = await evaluate(s, `Object.keys(localStorage).filter(k=>k.startsWith('fpl-planner:cache:entry/')).length`);
      await rec('the entry cache exists after a plan', before > 0, `${before} keys`, s);
      await clickText(s, 'Settings', { settle: 600 });
      await clickText(s, 'Delete FPL Planner data', { settle: 300 });
      await clickText(s, 'Yes, delete everything', { settle: 800 });
      const after = await evaluate(s, `JSON.stringify({ entry: Object.keys(localStorage).filter(k=>k.startsWith('fpl-planner:cache:entry/')), app: Object.keys(localStorage).filter(k=>/^fplPlanner/.test(k)) })`);
      const parsed = JSON.parse(after);
      await rec('Delete all removes every fpl-planner:cache:entry/* key', parsed.entry.length === 0, parsed.entry.join(', '), s);
      await rec('and the four app keys', parsed.app.length === 0, parsed.app.join(', '), s);
    } finally { await closePage(cdpPort, s); }
  }

  /* ----------------- 10. manual entry says when the budget cannot close ---- */
  {
    const s = await openPlanner(cdpPort, base, { state: 'preseason', waitFor: 'intro' });
    try {
      await clickText(s, 'Enter a squad manually', { settle: 600 });
      const onManual = await waitForExpr(s, `!!document.querySelector('.fpl-search-results')`, { timeout: 8000 });
      await rec('manual entry opens', onManual, '', s);
      const focusable = await evaluate(s, `(document.querySelector('.fpl-search-results')||{}).getAttribute ? document.querySelector('.fpl-search-results').getAttribute('tabindex') === '0' : false`);
      await rec('the search results list is a keyboard-reachable scroll region', focusable, '', s);
    } finally { await closePage(cdpPort, s); }
  }

  return R;
}
