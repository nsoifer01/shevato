// Accessibility suite: axe-core WCAG 2.0/2.1 A+AA scans over every site page
// and app root (plus two meaningful app states), and behavioral keyboard /
// focus checks that a static scanner cannot prove.
//
// Truthfulness rules this suite follows:
//   - color-contrast is NEVER excluded, dark theme or not. A page with genuine
//     serious/critical violations does not pass; it becomes a KNOWN DEFECT
//     skip carrying the full rule ids + counts + selectors.
//   - moderate/minor violations are reported as info in the detail of a
//     passing check, never as failures.
//   - Violations that repeat across (nearly) every site page with the same
//     rule + selector live in the shared header/footer chrome. They are
//     listed once, on the first page that carries them, and referenced from
//     the other pages' details instead of re-listed.
//   - Keyboard checks use real Input.dispatchKeyEvent keys; if the product
//     genuinely lacks a behavior, the truthful assertion is recorded as a
//     KNOWN DEFECT skip (expected-failure convention), never weakened to
//     green. No keyboard quarantines are open today.
//
// Arena note: its Firebase hosts are intercepted and failed BEFORE first
// navigation, same as suites/apps.mjs, so this scan can never sign in or
// write to the production project.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  newPage, closePage, goto, evaluate, evalAsync, waitForExpr, clickSel,
  clickText, setViewport, pressKey, sleep, interceptNetwork,
} from '../cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AXE_PATH = path.resolve(HERE, '..', 'vendor', 'axe.min.js');

const SITE_PAGES = ['home', 'work', 'apps', 'about', 'contact', 'privacy', '404', 'moadon-alef'];
const APP_ROOTS = ['arena', 'football-h2h', 'fpl-planner', 'gym-tracker',
  'maptap-rivals', 'mario-kart', 'rising-shows', 'trip-planner'];

// Same production-protection list as suites/apps.mjs.
const FIREBASE_HOSTS = /firestore\.googleapis\.com|firebaseio\.com|identitytoolkit\.googleapis\.com|securetoken\.googleapis\.com/i;

// Quarantine baseline: the ONLY scans allowed to carry serious/critical
// violations, and exactly which rule ids they may carry. Any entry must be
// catalogued as a defect in TESTING-AUDIT.md. Semantics, per the
// expected-failure convention (tests/browser/README.md):
//   - a scan listed here whose violations stay inside its allowed rule set
//     reports a KNOWN DEFECT skip (the defect is still present);
//   - a scan listed here that comes back with NO serious/critical violations
//     FAILS with an "unexpectedly clean" message, so a fixed defect must be
//     removed from this map in the fixing PR rather than rotting here;
//   - any violation on a scan NOT listed here, or any rule id outside the
//     allowed set, FAILS outright: it is a new regression, never a silent
//     addition to the quarantine.
const QUARANTINED = new Map([
  // Empty since the 2026-08-15 a11y fix round (defects 26-29 resolved): every
  // scan must come back with zero serious/critical violations. The map stays
  // so a future genuine quarantine keeps the same pinned-baseline mechanics.
]);

const CLEAR_STORAGE = `(()=>{ try{ for(const k of Object.keys(localStorage)) localStorage.removeItem(k);
  localStorage.clear(); sessionStorage.clear(); }catch(e){} return 1 })()`;

// Injects the vendored axe-core (v4.10.3) into the CURRENT document. Sent as
// one raw Runtime.evaluate because the source is a script, not an expression,
// so the evaluate() JSON wrapper cannot carry it.
async function injectAxe(s, axeSource) {
  await s.send('Runtime.evaluate', { expression: axeSource, returnByValue: false });
  return evaluate(s, "typeof window.axe==='object' && typeof window.axe.run==='function'");
}

// One WCAG2A/AA scan of the current document. Returns a compact violation
// list: rule id, impact, node count, first selectors.
async function axeScan(s) {
  return evalAsync(s, `window.axe.run(document, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
    resultTypes: ['violations'],
  }).then(r => r.violations.map(v => ({
    id: v.id, impact: v.impact, count: v.nodes.length,
    targets: v.nodes.slice(0, 6).map(n => (n.target || []).join(' ')),
  })))`);
}

const SERIOUS = new Set(['serious', 'critical']);
const pairsOf = (violations) => {
  const out = [];
  for (const v of violations || []) {
    if (!SERIOUS.has(v.impact)) continue;
    for (const target of v.targets) out.push(`${v.id} [${v.impact}] @ ${target}`);
  }
  return out;
};
const infoOf = (violations) => (violations || [])
  .filter((v) => !SERIOUS.has(v.impact))
  .map((v) => `${v.id}(${v.impact} x${v.count})`)
  .join(', ');

export async function run({ base, cdpPort }) {
  const R = [];
  const t = (name, pass, detail = '') => R.push({ name, pass: !!pass, detail });
  const skip = (name, reason) => R.push({ name, pass: true, skipped: true, detail: reason });

  const axeSource = await readFile(AXE_PATH, 'utf8');

  // ---------------------------------------------------------------- Part A
  // Scan everything first, then emit checks, so shared-chrome dedupe can see
  // the whole matrix before a single result is written.
  const scans = []; // { label, siteChrome, violations|null, err }

  // Site pages: one session, sequential.
  try {
    const s = await newPage(cdpPort);
    try {
      await setViewport(s, 1280, 900);
      for (const p of SITE_PAGES) {
        try {
          await goto(s, `${base}/${p}.html`, { settle: 2200 });
          const ok = await injectAxe(s, axeSource);
          const violations = ok ? await axeScan(s) : null;
          scans.push({
            label: `site ${p}`, siteChrome: p !== 'moadon-alef',
            violations: Array.isArray(violations) ? violations : null,
            err: Array.isArray(violations) ? '' : JSON.stringify(violations),
          });
        } catch (e) {
          scans.push({ label: `site ${p}`, siteChrome: false, violations: null, err: String(e && e.message).slice(0, 120) });
        }
      }
    } finally { await closePage(cdpPort, s); }
  } catch (e) {
    for (const p of SITE_PAGES) scans.push({ label: `site ${p}`, siteChrome: false, violations: null, err: String(e && e.message).slice(0, 120) });
  }

  // App roots: fresh storage per app so the scanned state is deterministic
  // whether this suite runs alone or after suites that left app state behind.
  for (const app of APP_ROOTS) {
    let s = null;
    try {
      s = await newPage(cdpPort);
      await setViewport(s, 1280, 900);
      if (app === 'arena') await interceptNetwork(s, (url) => (FIREBASE_HOSTS.test(url) ? 'fail' : null));
      await goto(s, `${base}/apps/${app}/`, { settle: 1000 });
      await evaluate(s, CLEAR_STORAGE);
      await goto(s, `${base}/apps/${app}/`, { settle: app === 'rising-shows' ? 4000 : 2500 });
      const ok = await injectAxe(s, axeSource);
      const violations = ok ? await axeScan(s) : null;
      scans.push({
        label: `app ${app}`, siteChrome: false,
        violations: Array.isArray(violations) ? violations : null,
        err: Array.isArray(violations) ? '' : JSON.stringify(violations),
      });
    } catch (e) {
      scans.push({ label: `app ${app}`, siteChrome: false, violations: null, err: String(e && e.message).slice(0, 120) });
    } finally { if (s) await closePage(cdpPort, s); }
  }

  // State scan 1: gym-tracker, onboarding dismissed + program modal open.
  {
    let s = null;
    try {
      s = await newPage(cdpPort);
      await setViewport(s, 1280, 900);
      await goto(s, `${base}/apps/gym-tracker/`, { settle: 1000 });
      await evaluate(s, CLEAR_STORAGE);
      await evaluate(s, `(()=>{ localStorage.setItem('gymTrackerOnboardingSeen','true'); return 1 })()`);
      await goto(s, `${base}/apps/gym-tracker/`, { settle: 1500 });
      await waitForExpr(s, '!!window.gymApp');
      await clickText(s, 'Programs', { sel: '.nav-links .nav-link', exact: true, settle: 900 });
      await clickSel(s, '#create-program-btn', { settle: 900 });
      const modalUp = await waitForExpr(s, "document.getElementById('program-modal').classList.contains('active')");
      if (!modalUp) throw new Error('program modal never opened');
      const ok = await injectAxe(s, axeSource);
      const violations = ok ? await axeScan(s) : null;
      scans.push({
        label: 'state gym-tracker program-modal', siteChrome: false,
        violations: Array.isArray(violations) ? violations : null,
        err: Array.isArray(violations) ? '' : JSON.stringify(violations),
      });
      await evaluate(s, `(()=>{ localStorage.removeItem('gymTrackerOnboardingSeen'); return 1 })()`);
    } catch (e) {
      scans.push({ label: 'state gym-tracker program-modal', siteChrome: false, violations: null, err: String(e && e.message).slice(0, 120) });
    } finally { if (s) await closePage(cdpPort, s); }
  }

  // State scan 2: trip-planner with the example trip loaded, Days view.
  {
    let s = null;
    try {
      s = await newPage(cdpPort);
      await setViewport(s, 1280, 900);
      await goto(s, `${base}/apps/trip-planner/`, { settle: 1000 });
      await evaluate(s, CLEAR_STORAGE);
      await goto(s, `${base}/apps/trip-planner/`, { settle: 1500 });
      await waitForExpr(s, `[...document.querySelectorAll('button,a')].some(x=>/load an example trip/i.test(x.textContent))`);
      await clickText(s, 'Load an example trip', { settle: 1200 });
      await waitForExpr(s, `(()=>{const b=document.getElementById('viewDays'); return !!b && !b.disabled})()`);
      await clickSel(s, '#viewDays', { settle: 1000 });
      await waitForExpr(s, `/on|active/.test(document.getElementById('viewDays').className)`);
      const ok = await injectAxe(s, axeSource);
      const violations = ok ? await axeScan(s) : null;
      scans.push({
        label: 'state trip-planner days-view', siteChrome: false,
        violations: Array.isArray(violations) ? violations : null,
        err: Array.isArray(violations) ? '' : JSON.stringify(violations),
      });
      await evaluate(s, `(()=>{ for(const k of Object.keys(localStorage))
        if(/^trip-planner/.test(k)) localStorage.removeItem(k); return 1 })()`);
    } catch (e) {
      scans.push({ label: 'state trip-planner days-view', siteChrome: false, violations: null, err: String(e && e.message).slice(0, 120) });
    } finally { if (s) await closePage(cdpPort, s); }
  }

  // Shared-chrome dedupe: a serious rule+selector pair present on most of the
  // chrome-bearing site pages lives in the injected header/footer, not the
  // page. It is listed in full once (first affected page) and referenced
  // elsewhere.
  const chromePages = scans.filter((x) => x.siteChrome && x.violations);
  const pairCounts = new Map();
  for (const x of chromePages) {
    for (const pair of new Set(pairsOf(x.violations))) {
      pairCounts.set(pair, (pairCounts.get(pair) || 0) + 1);
    }
  }
  const sharedThreshold = Math.max(2, chromePages.length - 1);
  const sharedPairs = new Set([...pairCounts].filter(([, n]) => n >= sharedThreshold).map(([p]) => p));
  let sharedListedOn = null;

  for (const x of scans) {
    const name = `a11y ${x.label}: no serious/critical WCAG2A/AA violations`;
    if (!x.violations) { t(name, false, `scan did not run: ${x.err}`); continue; }
    const pairs = pairsOf(x.violations);
    const info = infoOf(x.violations);
    const allowedRules = QUARANTINED.get(x.label);
    if (pairs.length === 0) {
      if (allowedRules) {
        t(name, false, 'unexpectedly clean - the pinned defect no longer reproduces; '
          + 'remove this scan from QUARANTINED and mark the defect resolved in TESTING-AUDIT.md');
      } else {
        t(name, true, info ? `moderate/minor (info only): ${info}` : '');
      }
      continue;
    }
    // Violations present: only quarantined scans may skip, and only for the
    // exact rule ids pinned at audit time. Anything else is a regression.
    const seriousRules = new Set(x.violations.filter((v) => SERIOUS.has(v.impact)).map((v) => v.id));
    const novel = [...seriousRules].filter((id) => !allowedRules || !allowedRules.has(id));
    if (novel.length) {
      t(name, false, `NEW serious/critical violation(s) beyond the pinned quarantine: `
        + x.violations.filter((v) => SERIOUS.has(v.impact) && novel.includes(v.id))
          .map((v) => `${v.id}(${v.impact} x${v.count}) @ ${v.targets.slice(0, 3).join(' , ')}`).join('; '));
      continue;
    }
    const own = pairs.filter((p) => !sharedPairs.has(p));
    const shared = pairs.filter((p) => sharedPairs.has(p));
    const ruleCounts = x.violations.filter((v) => SERIOUS.has(v.impact))
      .map((v) => `${v.id}(${v.impact} x${v.count})`).join(', ');
    let detail;
    if (shared.length && sharedListedOn === null) {
      sharedListedOn = x.label;
      detail = `shared chrome (header/footer, on ${chromePages.length} site pages): ${[...new Set(shared)].join('; ')}`
        + (own.length ? ` || page-own: ${[...new Set(own)].join('; ')}` : '');
    } else if (shared.length) {
      detail = (own.length ? `page-own: ${[...new Set(own)].join('; ')} || ` : '')
        + `plus ${new Set(shared).size} shared-chrome violation(s) listed under "${sharedListedOn}"`;
    } else {
      detail = [...new Set(own)].join('; ');
    }
    if (info) detail += ` || moderate/minor (info only): ${info}`;
    skip(name, `KNOWN DEFECT: ${ruleCounts} - ${detail}`);
  }

  // ---------------------------------------------------------------- Part B
  // Behavioral keyboard/focus checks driven with real keys.
  const TAB = (s, shift = false) => pressKey(s, 'Tab', 'Tab', 9, shift ? 8 : 0);
  const ESC = (s) => pressKey(s, 'Escape', 'Escape', 27);
  // Enter/Space pass their text so Chromium runs default actions (a button's
  // key-activated click); pressKey() takes it as its optional last argument.
  const ENTER = (s) => pressKey(s, 'Enter', 'Enter', 13, 0, '\r');
  const SPACE = (s) => pressKey(s, ' ', 'Space', 32, 0, ' ');

  // B1: home, Tab from the top walks the header nav links in DOM order, and
  // the focused link shows a visible focus indicator.
  try {
    const s = await newPage(cdpPort);
    try {
      await setViewport(s, 1280, 900);
      await goto(s, `${base}/home.html`, { settle: 2400 });
      await evaluate(s, `(()=>{ if(document.activeElement) document.activeElement.blur(); return 1 })()`);
      const seen = [];
      let focusStyle = null;
      for (let i = 0; i < 40; i++) {
        await TAB(s);
        const st = await evaluate(s, `(()=>{
          const links=[...document.querySelectorAll('#header nav a')];
          const idx=links.indexOf(document.activeElement);
          if (idx < 0) return { idx };
          const cs=getComputedStyle(document.activeElement);
          return { idx, outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, boxShadow: cs.boxShadow };
        })()`);
        if (st && st.idx >= 0) {
          seen.push(st.idx);
          if (!focusStyle) focusStyle = st;
        }
        if (seen.length >= 8) break;
      }
      const inOrder = seen.length >= 5 && seen.every((v, i) => i === 0 || v > seen[i - 1]);
      t('kbd home: Tab reaches the header nav links in DOM order', inOrder,
        `focused nav indices in order: [${seen.join(',')}]`);
      const visible = !!focusStyle && ((focusStyle.outlineStyle !== 'none' && parseFloat(focusStyle.outlineWidth) > 0)
        || (focusStyle.boxShadow && focusStyle.boxShadow !== 'none'));
      t('kbd home: focused nav link has a visible focus indicator', visible,
        focusStyle ? `outline=${focusStyle.outlineStyle} ${focusStyle.outlineWidth}, boxShadow=${focusStyle.boxShadow}` : 'no nav link ever focused');
    } finally { await closePage(cdpPort, s); }
  } catch (e) { t('kbd home: block ran', false, String(e && e.message).slice(0, 140)); }

  // B2: apps hub, search + filter buttons reachable by Tab, buttons operable
  // by Enter and Space (aria-pressed flips).
  try {
    const s = await newPage(cdpPort);
    try {
      await setViewport(s, 1280, 900);
      await goto(s, `${base}/apps.html`, { settle: 2000 });
      const wanted = await evaluate(s, `(()=>{
        const els=[document.getElementById('app-search'), ...document.querySelectorAll('.app-filter-bar button[data-filter]')];
        return els.filter(Boolean).length })()`);
      await evaluate(s, `(()=>{ if(document.activeElement) document.activeElement.blur();
        window.__tabbed=new Set(); return 1 })()`);
      for (let i = 0; i < 60; i++) {
        await TAB(s);
        const done = await evaluate(s, `(()=>{
          const a=document.activeElement;
          if (a && (a.id==='app-search' || (a.matches && a.matches('.app-filter-bar button[data-filter]'))))
            window.__tabbed.add(a.id || a.getAttribute('data-filter'));
          return window.__tabbed.size })()`);
        if (done >= wanted) break;
      }
      const reached = await evaluate(s, `window.__tabbed.size`);
      t('kbd apps hub: search input and every filter button reachable by Tab',
        reached === wanted, `${reached}/${wanted} reached`);

      const pressedExpr = (f) => `document.querySelector('.app-filter-bar button[data-filter="${f}"]').getAttribute('aria-pressed')`;
      await evaluate(s, `(()=>{document.querySelector('.app-filter-bar button[data-filter="fitness"]').focus(); return 1})()`);
      const beforeEnter = await evaluate(s, pressedExpr('fitness'));
      await ENTER(s);
      const afterEnter = await evaluate(s, pressedExpr('fitness'));
      t('kbd apps hub: Enter on a focused filter button flips aria-pressed',
        beforeEnter === 'false' && afterEnter === 'true', `${beforeEnter} -> ${afterEnter}`);

      await evaluate(s, `(()=>{document.querySelector('.app-filter-bar button[data-filter="game"]').focus(); return 1})()`);
      const beforeSpace = await evaluate(s, pressedExpr('game'));
      await SPACE(s);
      const afterSpace = await evaluate(s, pressedExpr('game'));
      t('kbd apps hub: Space on a focused filter button flips aria-pressed',
        beforeSpace === 'false' && afterSpace === 'true', `${beforeSpace} -> ${afterSpace}`);
    } finally { await closePage(cdpPort, s); }
  } catch (e) { t('kbd apps hub: block ran', false, String(e && e.message).slice(0, 140)); }

  // B3: mobile menu at 390x844. The menu is an HTML5UP panel; main.js
  // initializeMenu() sets hideOnEscape, so Escape must close the open menu
  // (defect 29, fixed 2026-08-15). The labelled close control is asserted on
  // a second open/close cycle.
  try {
    const s = await newPage(cdpPort);
    try {
      await setViewport(s, 390, 844, true);
      await goto(s, `${base}/home.html`, { settle: 2400 });
      const opened = await clickSel(s, 'a[href="#menu"]', { settle: 900 });
      const menuVisible = `(()=>{ return document.body.classList.contains('is-menu-visible') })()`;
      const openState = await evaluate(s, `(()=>({
        vis: document.body.classList.contains('is-menu-visible'),
        expanded: (document.querySelector('[data-js="menu-toggle"]')||{getAttribute:()=>null}).getAttribute('aria-expanded'),
      }))()`);
      t('kbd mobile menu: opens via the toggle (aria-expanded=true)',
        opened && openState.vis && openState.expanded === 'true', JSON.stringify(openState));

      await ESC(s);
      await sleep(600);
      const stillOpen = await evaluate(s, menuVisible);
      t('kbd mobile menu: Escape closes the open menu', !stillOpen,
        stillOpen ? 'menu still visible after Escape' : '');

      // Reopen (the panel plugin locks for its 500ms delay after a hide) and
      // close via the labelled close control.
      await sleep(700);
      await clickSel(s, 'a[href="#menu"]', { settle: 900 });
      const reopened = await evaluate(s, menuVisible);
      await clickSel(s, '#menu a.close', { settle: 900 });
      const closedState = await evaluate(s, `(()=>({
        vis: document.body.classList.contains('is-menu-visible'),
        expanded: (document.querySelector('[data-js="menu-toggle"]')||{getAttribute:()=>null}).getAttribute('aria-expanded'),
        hidden: (document.getElementById('menu')||{getAttribute:()=>null}).getAttribute('aria-hidden'),
      }))()`);
      t('kbd mobile menu: close control closes and syncs aria state',
        reopened && !closedState.vis && closedState.expanded === 'false' && closedState.hidden === 'true',
        `reopened=${reopened} ${JSON.stringify(closedState)}`);
    } finally { await closePage(cdpPort, s); }
  } catch (e) { t('kbd mobile menu: block ran', false, String(e && e.message).slice(0, 140)); }

  // B4: auth modal focus handling (assets/js/main.js: #auth-signin-btn opens
  // #auth-modal; showAuthModal focuses the first visible input after 100ms;
  // document-level Tab trap while open; Escape hides and refocuses the
  // trigger). The Sign In button only renders once Firebase auth initializes
  // and reports signed-out; if that never happens here it is a missing
  // precondition, not a product bug.
  try {
    const s = await newPage(cdpPort);
    try {
      await setViewport(s, 1280, 900);
      await goto(s, `${base}/home.html`, { settle: 2400 });
      const btnUp = await waitForExpr(s, `(()=>{const b=document.getElementById('auth-signin-btn');
        return !!b && b.getBoundingClientRect().height>0})()`, { timeout: 12000 });
      if (!btnUp) {
        const reason = 'precondition missing: #auth-signin-btn never rendered (Firebase auth did not initialize in this environment)';
        skip('kbd auth modal: focus moves into the dialog on open', reason);
        skip('kbd auth modal: Tab keeps focus inside the open dialog', reason);
        skip('kbd auth modal: Escape closes and returns focus to the trigger', reason);
      } else {
        await clickSel(s, '#auth-signin-btn', { settle: 700 });
        const focusIn = await waitForExpr(s, `(()=>{
          const m=document.getElementById('auth-modal');
          return !!m && m.classList.contains('auth-modal--visible') && m.contains(document.activeElement)
        })()`, { timeout: 4000 });
        t('kbd auth modal: focus moves into the dialog on open', focusIn,
          String(await evaluate(s, `(document.activeElement||{}).id || (document.activeElement||{}).tagName`)));

        let escaped = null;
        for (let i = 0; i < 14; i++) {
          await TAB(s);
          const inside = await evaluate(s, `(()=>{
            const m=document.getElementById('auth-modal');
            return !!m && m.contains(document.activeElement)})()`);
          if (!inside) {
            escaped = await evaluate(s, `(document.activeElement||{}).id
              || ((document.activeElement||{}).getAttribute && document.activeElement.getAttribute('aria-label'))
              || (document.activeElement||{}).tagName`);
            break;
          }
        }
        t('kbd auth modal: Tab keeps focus inside the open dialog', escaped === null,
          escaped === null ? '14 Tabs stayed inside'
            : `Tab escaped the open auth dialog to "${escaped}"`);

        await ESC(s);
        await sleep(500);
        const afterEsc = await evaluate(s, `(()=>({
          open: document.getElementById('auth-modal').classList.contains('auth-modal--visible'),
          focusOnTrigger: document.activeElement === document.getElementById('auth-signin-btn'),
        }))()`);
        t('kbd auth modal: Escape closes and returns focus to the trigger',
          !afterEsc.open && afterEsc.focusOnTrigger, JSON.stringify(afterEsc));
      }
    } finally { await closePage(cdpPort, s); }
  } catch (e) { t('kbd auth modal: block ran', false, String(e && e.message).slice(0, 140)); }

  // B5: fpl-planner combobox deliberately not repeated here; it already has
  // dedicated unit-level a11y coverage.

  // B6: gym-tracker modal focus module (js/utils/modal-focus.js): with the
  // program editor open, focus moves in, Tab wraps within the modal, Escape
  // closes it and focus returns to the trigger.
  try {
    const s = await newPage(cdpPort);
    try {
      await setViewport(s, 1280, 900);
      await goto(s, `${base}/apps/gym-tracker/`, { settle: 1000 });
      await evaluate(s, CLEAR_STORAGE);
      await evaluate(s, `(()=>{ localStorage.setItem('gymTrackerOnboardingSeen','true'); return 1 })()`);
      await goto(s, `${base}/apps/gym-tracker/`, { settle: 1500 });
      await waitForExpr(s, '!!window.gymApp');
      await clickText(s, 'Programs', { sel: '.nav-links .nav-link', exact: true, settle: 900 });
      await clickSel(s, '#create-program-btn', { settle: 900 });
      const focusIn = await waitForExpr(s, `(()=>{
        const m=document.getElementById('program-modal');
        return !!m && m.classList.contains('active') && m.contains(document.activeElement)
      })()`, { timeout: 4000 });
      t('kbd gym-tracker: focus moves into the program modal on open', focusIn,
        String(await evaluate(s, `(document.activeElement||{}).id || (document.activeElement||{}).tagName`)));

      let left = null;
      for (let i = 0; i < 20; i++) {
        await TAB(s);
        const inside = await evaluate(s, `(()=>{
          const m=document.getElementById('program-modal');
          return !!m && m.contains(document.activeElement)})()`);
        if (!inside) {
          left = await evaluate(s, `(document.activeElement||{}).id || (document.activeElement||{}).tagName`);
          break;
        }
      }
      t('kbd gym-tracker: Tab wraps within the open modal', left === null,
        left === null ? '20 Tabs stayed inside' : `escaped to "${left}"`);

      await ESC(s);
      const closed = await waitForExpr(s,
        `!document.getElementById('program-modal').classList.contains('active')`, { timeout: 4000 });
      t('kbd gym-tracker: Escape closes the modal', closed);
      await sleep(500);
      const restored = await evaluate(s,
        `document.activeElement === document.getElementById('create-program-btn')`);
      t('kbd gym-tracker: focus returns to the trigger after close', !!restored,
        String(await evaluate(s, `(document.activeElement||{}).id || (document.activeElement||{}).tagName`)));
      await evaluate(s, CLEAR_STORAGE);
    } finally { await closePage(cdpPort, s); }
  } catch (e) { t('kbd gym-tracker: block ran', false, String(e && e.message).slice(0, 140)); }

  // B7: mobile menu as a modal overlay at 390x844 (assets/js/main.js
  // initializeMenu: focus moves to the first link on open, Tab/Shift+Tab
  // wrap inside #menu, Escape hands focus back to the toggle; main.css locks
  // body scroll while is-menu-visible is set). The Tab wrap is driven with
  // real keys; only the starting element of each wrap is placed with
  // focus(), because the trap is a keydown handler and a synthetic focus
  // change alone proves nothing.
  try {
    const s = await newPage(cdpPort);
    try {
      await setViewport(s, 390, 844, true);
      await goto(s, `${base}/home.html`, { settle: 2400 });
      await clickSel(s, 'a[href="#menu"]', { settle: 900 });
      const opened = await evaluate(s, `(()=>({
        vis: document.body.classList.contains('is-menu-visible'),
        focusInside: document.getElementById('menu').contains(document.activeElement),
        active: (document.activeElement||{}).textContent || (document.activeElement||{}).tagName,
        overflow: getComputedStyle(document.body).overflow,
      }))()`);
      t('kbd mobile menu: focus moves inside #menu on open', opened.vis && opened.focusInside,
        JSON.stringify(opened));
      t('kbd mobile menu: body scroll is locked while the menu is open', opened.overflow === 'hidden',
        `body overflow=${opened.overflow}`);

      const focusLast = `(()=>{ const f=[...document.querySelectorAll('#menu a[href], #menu button:not([disabled])')];
        f[f.length-1].focus(); return f.length })()`;
      const focusFirst = `(()=>{ const f=[...document.querySelectorAll('#menu a[href], #menu button:not([disabled])')];
        f[0].focus(); return f.length })()`;
      const whichItem = `(()=>{ const f=[...document.querySelectorAll('#menu a[href], #menu button:not([disabled])')];
        return { idx: f.indexOf(document.activeElement), n: f.length } })()`;
      const n = await evaluate(s, focusLast);
      await TAB(s);
      const afterTab = await evaluate(s, whichItem);
      t('kbd mobile menu: Tab from the last focusable wraps to the first', n > 1 && afterTab.idx === 0,
        `focusables=${n}, landed on index ${afterTab.idx}`);
      await evaluate(s, focusFirst);
      await TAB(s, true);
      const afterShiftTab = await evaluate(s, whichItem);
      t('kbd mobile menu: Shift+Tab from the first focusable wraps to the last',
        afterShiftTab.idx === afterShiftTab.n - 1 && afterShiftTab.n === n,
        `focusables=${afterShiftTab.n}, landed on index ${afterShiftTab.idx}`);

      await ESC(s);
      await sleep(700);
      const closed = await evaluate(s, `(()=>({
        vis: document.body.classList.contains('is-menu-visible'),
        focusOnToggle: document.activeElement === document.querySelector('[data-js="menu-toggle"]'),
        active: (document.activeElement||{}).textContent || (document.activeElement||{}).tagName,
        overflow: getComputedStyle(document.body).overflow,
      }))()`);
      t('kbd mobile menu: Escape returns focus to the toggle', !closed.vis && closed.focusOnToggle,
        JSON.stringify(closed));
      t('kbd mobile menu: body scroll unlocks after close', !closed.vis && closed.overflow !== 'hidden',
        `body overflow=${closed.overflow}`);
    } finally { await closePage(cdpPort, s); }
  } catch (e) { t('kbd mobile menu focus: block ran', false, String(e && e.message).slice(0, 140)); }

  // B8: the header Sign In button is a real touch target at both viewports
  // (main.css pins #header .auth__button to min-height 44px, the WCAG 2.5.8
  // AAA / Material minimum; 24x24 is the AA floor). Same precondition as
  // B4: the button only renders once Firebase auth reports signed-out.
  for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
    const name = `touch target: header Sign In button is at least 44px tall and 24px wide at ${w}`;
    try {
      const s = await newPage(cdpPort);
      try {
        await setViewport(s, w, h, mobile);
        await goto(s, `${base}/home.html`, { settle: 2400 });
        const btnUp = await waitForExpr(s, `(()=>{const b=document.getElementById('auth-signin-btn');
          return !!b && b.getBoundingClientRect().height>0})()`, { timeout: 12000 });
        if (!btnUp) {
          skip(name, 'precondition missing: #auth-signin-btn never rendered (Firebase auth did not initialize in this environment)');
        } else {
          const box = await evaluate(s, `(()=>{ const r=document.getElementById('auth-signin-btn').getBoundingClientRect();
            return { w: Math.round(r.width), h: Math.round(r.height) } })()`);
          t(name, box.h >= 44 && box.w >= 24, `${box.w}x${box.h}`);
        }
      } finally { await closePage(cdpPort, s); }
    } catch (e) { t(name, false, String(e && e.message).slice(0, 140)); }
  }

  // B9: landmarks and skip link on every site page and app root. Exactly one
  // main landmark (a <main> or [role=main]) carrying id="main-content", the
  // FIRST Tab from the top of the document lands on a.skip-link whose href
  // is #main-content (real key, so the skip link is proven first in focus
  // order, not just first in source), and the shared header carries one nav
  // labelled "Main navigation" and one labelled "Menu toggle". moadon-alef
  // is a standalone landing without the shared header, so only the
  // landmark/skip-link half applies to it. gym-tracker opens its onboarding
  // dialog on first visit and a modal dialog legitimately owns focus, so it
  // is visited with the dialog already dismissed (same seed as the state
  // scan above).
  const LANDMARK_PAGES = [
    ...SITE_PAGES.map((p) => ({ label: `site ${p}`, url: `${base}/${p}.html`, header: p !== 'moadon-alef', settle: 2400 })),
    ...APP_ROOTS.map((a) => ({ label: `app ${a}`, url: `${base}/apps/${a}/`, header: true, settle: a === 'rising-shows' ? 4000 : 2500 })),
  ];
  for (const pg of LANDMARK_PAGES) {
    let s = null;
    try {
      s = await newPage(cdpPort);
      await setViewport(s, 1280, 900);
      if (pg.label === 'app arena') await interceptNetwork(s, (url) => (FIREBASE_HOSTS.test(url) ? 'fail' : null));
      if (pg.label === 'app gym-tracker') {
        await goto(s, pg.url, { settle: 1000 });
        await evaluate(s, `(()=>{ localStorage.setItem('gymTrackerOnboardingSeen','true'); return 1 })()`);
      }
      await goto(s, pg.url, { settle: pg.settle });
      if (pg.label === 'app gym-tracker') await evaluate(s, `(()=>{ localStorage.removeItem('gymTrackerOnboardingSeen'); return 1 })()`);
      if (pg.header) await waitForExpr(s, `!!document.querySelector('#header nav')`, { timeout: 8000 });
      await evaluate(s, `(()=>{ if(document.activeElement) document.activeElement.blur(); return 1 })()`);
      await TAB(s);
      const st = await evaluate(s, `(()=>{
        const mains=[...document.querySelectorAll('main, [role="main"]')];
        const a=document.activeElement;
        const navs=[...document.querySelectorAll('#header nav')].map(n=>n.getAttribute('aria-label'));
        return {
          mains: mains.length, mainId: mains.length===1 ? mains[0].id : mains.map(m=>m.id).join('|'),
          firstFocus: a ? (a.tagName.toLowerCase()+(a.className?'.'+String(a.className).split(' ')[0]:'')+' '+(a.getAttribute('href')||'')) : 'none',
          skipLinkFirst: !!a && a.matches('a.skip-link') && a.getAttribute('href')==='#main-content',
          navMain: navs.filter(l=>l==='Main navigation').length,
          navToggle: navs.filter(l=>l==='Menu toggle').length,
          navs,
        } })()`);
      t(`landmarks ${pg.label}: one main#main-content and the skip link is the first Tab stop`,
        st.mains === 1 && st.mainId === 'main-content' && st.skipLinkFirst,
        `mains=${st.mains} id=${st.mainId} firstFocus=${st.firstFocus}`);
      if (pg.header) {
        t(`landmarks ${pg.label}: header has one "Main navigation" nav and one "Menu toggle" nav`,
          st.navMain === 1 && st.navToggle === 1, `header nav labels: ${JSON.stringify(st.navs)}`);
      }
    } catch (e) {
      t(`landmarks ${pg.label}: one main#main-content and the skip link is the first Tab stop`, false, String(e && e.message).slice(0, 140));
      if (pg.header) t(`landmarks ${pg.label}: header has one "Main navigation" nav and one "Menu toggle" nav`, false, 'page block threw');
    } finally { if (s) await closePage(cdpPort, s); }
  }

  return R;
}
