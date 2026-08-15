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
//   - Keyboard checks use real Input.dispatchKeyEvent keys; where the product
//     genuinely lacks a behavior (Escape on the mobile menu), the truthful
//     assertion is recorded as a KNOWN DEFECT skip, never weakened to green.
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
// violations, and exactly which rule ids they may carry. Catalogued in
// TESTING-AUDIT.md (defects 26-28). Semantics, per the expected-failure
// convention (tests/browser/README.md):
//   - a scan listed here whose violations stay inside its allowed rule set
//     reports a KNOWN DEFECT skip (the defect is still present);
//   - a scan listed here that comes back with NO serious/critical violations
//     FAILS with an "unexpectedly clean" message, so a fixed defect must be
//     removed from this map in the fixing PR rather than rotting here;
//   - any violation on a scan NOT listed here, or any rule id outside the
//     allowed set, FAILS outright: it is a new regression, never a silent
//     addition to the quarantine.
const QUARANTINED = new Map([
  ['site moadon-alef', new Set(['color-contrast'])],
  ['app maptap-rivals', new Set(['color-contrast'])],
  ['app mario-kart', new Set(['aria-required-children', 'aria-required-parent'])],
  ['state gym-tracker program-modal', new Set(['color-contrast'])],
  ['state trip-planner days-view', new Set(['color-contrast'])],
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
  // Enter/Space need the `text` field on the keyDown or Chromium treats it as
  // a rawKeyDown and skips default actions (a button's key-activated click),
  // which pressKey() does not set. Same Input.dispatchKeyEvent path otherwise.
  const pressKeyText = async (s, key, code, keyCode, text) => {
    const p = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
    await s.send('Input.dispatchKeyEvent', { type: 'keyDown', ...p, text, unmodifiedText: text });
    await s.send('Input.dispatchKeyEvent', { type: 'keyUp', ...p });
    await sleep(200);
  };
  const ENTER = (s) => pressKeyText(s, 'Enter', 'Enter', 13, '\r');
  const SPACE = (s) => pressKeyText(s, ' ', 'Space', 32, ' ');

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

  // B3: mobile menu at 390x844. The menu is an HTML5UP panel; util.js only
  // wires Escape when hideOnEscape is set, and main.js does not set it, so
  // Escape genuinely does nothing. That gap is recorded as a KNOWN DEFECT
  // skip; the working close path (the labelled close control) is asserted.
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
      if (stillOpen) {
        skip('kbd mobile menu: Escape closes the open menu',
          'KNOWN DEFECT: Escape does not close the open mobile menu - the panel plugin (assets/js/util.js) only binds Escape when hideOnEscape is set and main.js initializeMenu() never sets it');
      } else {
        t('kbd mobile menu: Escape closes the open menu', false,
          'unexpectedly passes - the pinned defect no longer reproduces; convert this quarantine into a plain assertion and mark defect 29 resolved in TESTING-AUDIT.md');
      }

      if (stillOpen) await clickSel(s, '#menu a.close', { settle: 900 });
      const closedState = await evaluate(s, `(()=>({
        vis: document.body.classList.contains('is-menu-visible'),
        expanded: (document.querySelector('[data-js="menu-toggle"]')||{getAttribute:()=>null}).getAttribute('aria-expanded'),
        hidden: (document.getElementById('menu')||{getAttribute:()=>null}).getAttribute('aria-hidden'),
      }))()`);
      t('kbd mobile menu: close control closes and syncs aria state',
        !closedState.vis && closedState.expanded === 'false' && closedState.hidden === 'true',
        JSON.stringify(closedState));
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
        if (escaped === null) {
          t('kbd auth modal: Tab keeps focus inside the open dialog', false,
            'unexpectedly passes - the pinned defect no longer reproduces; convert this quarantine into a plain assertion and mark defect 26 resolved in TESTING-AUDIT.md');
        } else {
          skip('kbd auth modal: Tab keeps focus inside the open dialog',
            `KNOWN DEFECT: Tab escapes the open auth dialog to "${escaped}" - main.js trapFocus() computes first/last over ALL focusable elements including the hidden signup form, so the boundary element can never hold focus and the wrap never fires`);
        }

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

  return R;
}
