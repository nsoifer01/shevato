// Rising Shows: regressions from the 2026-08-22 site-wide audit.
//
// Runs through tests/browser/run.mjs like the trip-planner and fpl-planner
// suites (raw CDP, coordinate clicks, no framework). Every check needs the
// gitignored dataset (data-index.json + data/detail/*); without it the whole
// suite records actionable skips, the same way suites/apps.mjs does.
//
// Covered here and nowhere else:
//   D1/U1  a search typed while the index downloads survives the load, and the
//          count line reports progress while it does
//   D2     rating sorts rank 1,000+ vote shows first with votes at "Any", with
//          a visible ranking note
//   D3     pager buttons paint a real focus ring
//   D4     a malformed index reaches the error panel instead of a frozen skeleton
//   D5     Esc in a season modal steps back to the show modal
//   D7     a failed detail fetch shows a retry line and keeps the index counts
//   D8     the hash carries a trimmed search term
//   D9     axe on the open show modal and season modal (list / nested-interactive)
//   D10    footer meta contrast
//   U2/U3/U5/U6/U7/U11 confidence pills, sticky mobile close, collapsed shape
//          rail, chip-row scroll affordance, pager landing, plain "+"
//   plus seeded axe scans of the finder, both modals and the Kometa builder at
//   1280 and 390, and a built SEO page smoke when shows/ exists.
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  newPage, closePage, goto, evaluate as evaluateRaw, evalAsync, waitForExpr, clickSel, clickText,
  setViewport, pressKey, typeInto, setValue, sleep, interceptNetwork, cleanErrors, screenshot,
} from '../../../tests/browser/cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const APP = '/apps/rising-shows/';
const AXE_PATH = path.join(REPO, 'tests', 'browser', 'vendor', 'axe.min.js');
const ART_DIR = path.join(REPO, '.screenshots', 'e2e-rising-shows');
const CARD = '.finder-card:not(.skeleton),tbody tr';
const READY = `!!document.querySelector(${JSON.stringify(CARD)})`;
// Breaking Bad: 5 seasons, a season-5 "big-finale" label at confidence 0.10,
// 2.6M votes. Its detail file and built page exist in every dataset release.
const SHOW = 'tt0903747';

const exists = (p) => access(p).then(() => true, () => false);

// Checks below build their read-outs with JSON.stringify inside the page so
// one evaluate carries several facts; cdp.evaluate hands that back as a
// string, so unwrap it here.
async function evaluate(s, expr) {
  const v = await evaluateRaw(s, expr);
  if (typeof v === 'string' && /^[\[{]/.test(v)) { try { return JSON.parse(v); } catch { return v; } }
  return v;
}

export async function run({ base, cdpPort }) {
  const R = [];
  const t = (name, pass, detail = '') => R.push({ name, pass: !!pass, detail: detail ? String(detail).slice(0, 200) : '' });
  const skip = (name, reason) => R.push({ name, pass: true, skipped: true, detail: reason });
  const shot = async (s, name) => {
    try {
      await (await import('node:fs/promises')).mkdir(ART_DIR, { recursive: true });
      await screenshot(s, path.join(ART_DIR, `${name}.png`));
    } catch { /* artifact only */ }
  };
  const axeSource = await readFile(AXE_PATH, 'utf8');
  const axe = async (s) => {
    await s.send('Runtime.evaluate', { expression: axeSource, returnByValue: false });
    return evalAsync(s, `window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] }, resultTypes: ['violations'],
    }).then(r => r.violations.filter(v => v.impact === 'serious' || v.impact === 'critical')
      .map(v => v.id + ' x' + v.nodes.length + ' ' + (v.nodes[0].target || []).join(' ')))`);
  };
  const axeCheck = async (s, name) => {
    const v = await axe(s);
    t(`axe: ${name} has no serious/critical violations`, Array.isArray(v) && v.length === 0,
      Array.isArray(v) ? v.slice(0, 4).join(' | ') : String(v));
  };
  const fresh = async () => newPage(cdpPort);
  const open = async (s, hash = '', { w = 1280, h = 900, mobile = false } = {}) => {
    await setViewport(s, w, h, mobile);
    // A hash-only navigation never fires the load event; bounce via blank.
    await goto(s, 'about:blank', { settle: 100 });
    await goto(s, `${base}${APP}${hash}`, { settle: 300 });
    return waitForExpr(s, READY, { timeout: 30000 });
  };

  const haveData = await exists(path.join(REPO, 'apps', 'rising-shows', 'data-index.json'))
    && await exists(path.join(REPO, 'apps', 'rising-shows', 'data', 'detail', `${SHOW}.json`));
  if (!haveData) {
    const reason = 'no show data - run `npm run fetch:rising-shows-data` then `npm run build:rising-shows:split`';
    for (const n of ['throttled load keeps the typed search', 'rating sort vote floor', 'pager focus ring',
      'malformed index reaches the error panel', 'Esc steps back from season to show', 'detail 404 retry line',
      'hash trims the search term', 'axe finder/modals/kometa', 'footer meta contrast', 'mobile ergonomics',
      'built SEO page smoke']) skip(`rising-shows audit: ${n}`, reason);
    return R;
  }

  /* ------------------------------------------- 1. throttled load (D1 / U1) */
  {
    const s = await fresh();
    try {
      await setViewport(s, 1280, 900);
      await s.send('Network.enable');
      await s.send('Network.setCacheDisabled', { cacheDisabled: true });
      // ~3 MB/s: the 34 MB index takes 10+ s, long enough to type into.
      await s.send('Network.emulateNetworkConditions', {
        offline: false, latency: 50, downloadThroughput: 3_000_000, uploadThroughput: 1_000_000,
      });
      await s.send('Page.navigate', { url: `${base}${APP}` });
      const skel = await waitForExpr(s, `document.querySelectorAll('.skeleton').length > 0 && !!document.getElementById('finderSearch')`, { timeout: 20000 });
      t('throttled load: skeleton cards appear before the index lands', skel);
      await sleep(1500);
      const during = await evaluate(s, `JSON.stringify({
        count: document.getElementById('finderCount').textContent,
        busy: document.getElementById('finderSearch').getAttribute('aria-busy'),
        live: document.getElementById('finderCount').getAttribute('aria-live'),
        ready: ${READY} })`);
      t('U1: the count line reports "Loading show index" with progress while loading',
        !during.ready && /Loading show index \(\d+ (of \d+ )?MB\)/.test(during.count), during.count);
      t('U1: the status line is aria-live and the search box is marked busy',
        during.live === 'polite' && during.busy === 'true', JSON.stringify(during));
      await typeInto(s, '#finderSearch', 'breaking');
      const ready = await waitForExpr(s, READY, { timeout: 90000 });
      await sleep(800);
      const after = await evaluate(s, `JSON.stringify({
        value: document.getElementById('finderSearch').value,
        hash: location.hash,
        count: document.getElementById('finderCount').textContent,
        busy: document.getElementById('finderSearch').getAttribute('aria-busy') })`);
      t('D1: a search typed during the load survives in the box', ready && after.value === 'breaking', JSON.stringify(after));
      t('D1: and is applied (hash carries it, results are narrowed)',
        after.hash === '#q=breaking' && /^\d{1,3} shows? match/.test(after.count), JSON.stringify(after));
      t('U1: the busy marker clears once the index is in', after.busy === null);
      if (!ready || after.value !== 'breaking') await shot(s, 'd1-throttled');
      await s.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    } catch (e) {
      t('rising-shows audit: section completed', false, String(e && e.message || e));
    } finally { await closePage(cdpPort, s); }
  }

  /* ------------------------------------ 2. desktop finder (D2 D8 D10 U7 axe) */
  {
    const s = await fresh();
    try {
      const ready = await open(s);
      t('finder renders with data', ready);
      await axeCheck(s, 'finder with results at 1280');

      // D8
      await setValue(s, '#finderSearch', '  breaking  ');
      await waitForExpr(s, `location.hash.includes('q=')`, { timeout: 5000 });
      t('D8: a padded search term is trimmed in the hash', (await evaluate(s, 'location.hash')) === '#q=breaking',
        await evaluate(s, 'location.hash'));
      await setValue(s, '#finderSearch', '   ');
      await sleep(600);
      t('D8: a whitespace-only term writes no q= at all', !(await evaluate(s, `location.hash.includes('q=')`)),
        await evaluate(s, 'location.hash'));
      await setValue(s, '#finderSearch', '');
      await sleep(600);

      // D10
      const contrast = await evaluate(s, `(()=>{
        const lum = (c) => { const [r,g,b] = c.match(/\\d+/g).map(Number).map(v => v/255)
          .map(v => v <= 0.03928 ? v/12.92 : ((v+0.055)/1.055) ** 2.4); return 0.2126*r + 0.7152*g + 0.0722*b; };
        const el = document.querySelector('.footer-meta-text') || document.querySelector('.footer-meta');
        if (!el) return null;
        const fg = lum(getComputedStyle(el).color);
        const bg = lum(getComputedStyle(document.body).backgroundColor);
        return Math.round(((Math.max(fg,bg)+0.05)/(Math.min(fg,bg)+0.05))*100)/100; })()`);
      t('D10: footer meta text is at least 4.5:1 on the page background', contrast != null && contrast >= 4.5, `${contrast}:1`);

      // U7
      const clickedNext = await clickText(s, 'Next', { sel: '.pager-top .page-btn', settle: 1200 });
      const landing = await evaluate(s, `(()=>{ const c = document.getElementById('finderCount').getBoundingClientRect();
        const hdr = document.getElementById('header'); const hh = hdr ? hdr.getBoundingClientRect().bottom : 0;
        return JSON.stringify({ top: Math.round(c.top), hdrBottom: Math.round(hh), page: location.hash }); })()`);
      t('U7: after Next the count line sits below the fixed header, inside the viewport',
        clickedNext && landing.top >= landing.hdrBottom && landing.top < 400 && /page=2/.test(landing.page), JSON.stringify(landing));

      // D2: rating sort with votes "Any"
      await open(s, '#sort=avgEpisode');
      const parseVotes = `(txt)=>{ const m = txt.match(/([\\d.]+)\\s*([kM]?)\\s*votes/); if(!m) return null;
        return Math.round(parseFloat(m[1]) * (m[2]==='M'?1e6:m[2]==='k'?1e3:1)); }`;
      const top = await evaluate(s, `(()=>{ const p = ${parseVotes};
        const cards = [...document.querySelectorAll('.finder-card:not(.skeleton)')].slice(0, 24);
        const votes = cards.map(c => p(c.innerText));
        const note = document.querySelector('.active-filter-note');
        return JSON.stringify({ votes, note: note ? note.textContent : null, title: note ? note.title : '' }); })()`);
      const votes = (top && top.votes) || [];
      t('D2: "Avg episode rating" descending opens on 1,000+ vote shows, not 7-vote titles',
        votes.length > 0 && votes.every((v) => v != null && v >= 1000), JSON.stringify(votes.slice(0, 6) || top));
      t('D2: the ranking floor is visible as a note in the active-filter bar',
        top && /Ranking/.test(top.note || '') && /1,000\+ votes first/.test(top.note || '') && /Set a votes filter/.test(top.title), JSON.stringify(top).slice(0, 160));
      await open(s, '#sort=showRating&minVotes=5');
      const withFloor = await evaluate(s, `JSON.stringify({ note: !!document.querySelector('.active-filter-note'),
        first: (${parseVotes})((document.querySelector('.finder-card:not(.skeleton)')||{innerText:''}).innerText) })`);
      t('D2: a user-set votes filter takes over (no note, plain rating order)', !withFloor.note && withFloor.first != null && withFloor.first < 1000, JSON.stringify(withFloor));
    } catch (e) {
      t('rising-shows audit: section completed', false, String(e && e.message || e));
    } finally { await closePage(cdpPort, s); }
  }

  /* ------------------------------------------------ 3. pager focus ring (D3) */
  {
    // Fresh page and no mouse click first: Chromium only treats script focus as
    // :focus-visible when the last interaction was not a pointer.
    const s = await fresh();
    try {
      await open(s);
      // Script focus is not :focus-visible after a navigation in headless
      // Chromium; a real Tab away and Shift+Tab back makes the focus
      // keyboard-originated, which is exactly the case the ring exists for.
      await evaluate(s, `(()=>{ const b = document.querySelector('.pager .page-btn:not([disabled])'); b.scrollIntoView({block:'center'}); b.focus(); return 1 })()`);
      await pressKey(s, 'Tab', 'Tab', 9);
      await pressKey(s, 'Tab', 'Tab', 9, 8);
      const ring = await evaluate(s, `(()=>{ const b = document.activeElement; if (!b || !b.classList.contains('page-btn')) return { active: b && b.outerHTML.slice(0, 60) };
        const cs = getComputedStyle(b);
        return JSON.stringify({ fv: b.matches(':focus-visible'), shadow: cs.boxShadow, outline: cs.outlineStyle }); })()`);
      t('D3: a keyboard-focused pager button paints a ring (box-shadow or outline)',
        ring && ring.fv && (ring.shadow !== 'none' || ring.outline !== 'none'), JSON.stringify(ring));
    } catch (e) {
      t('rising-shows audit: section completed', false, String(e && e.message || e));
    } finally { await closePage(cdpPort, s); }
  }

  /* ---------------------------------- 4. show + season modals (D5 D9 U2 U11) */
  {
    const s = await fresh();
    try {
      await open(s, `#show=${SHOW}`);
      const modal = await waitForExpr(s, `!document.getElementById('showModal').hidden && document.querySelectorAll('#showModalSeasons > li').length > 0`, { timeout: 15000 });
      t('show modal opens from a deep link', modal);
      const rows = await evaluate(s, `(()=>{ const lis = [...document.querySelectorAll('#showModalSeasons > li')];
        return JSON.stringify({ n: lis.length, roleButtons: lis.filter(l => l.getAttribute('role') === 'button').length,
          openButtons: lis.filter(l => l.querySelector('button.ss-num')).length,
          eps: lis.map(l => (l.querySelector('.ss-eps')||{}).textContent || ''),
          low: [...document.querySelectorAll('.shape-tag.is-low-confidence')].map(b => ({ t: b.textContent, title: b.title, op: getComputedStyle(b).opacity })),
          compare: document.getElementById('showModalCompare').textContent }); })()`);
      t('D9: season rows are plain list items with a real button to open them',
        rows.n > 0 && rows.roleButtons === 0 && rows.openButtons === rows.n, JSON.stringify(rows).slice(0, 160));
      t('D7: season rows show their episode counts', rows.eps.length > 0 && rows.eps.every((e) => /^[1-9]\d* eps/.test(e)), rows.eps.join(' | '));
      t('U2: a low-confidence shape pill is dimmed and says so',
        rows.low.length > 0 && rows.low.every((p) => parseFloat(p.op) < 1 && /Low confidence \(0\.\d\d\)/.test(p.title)), JSON.stringify(rows.low[0] || null));
      t('U11: the compare button uses a plain "+"', /^\+ Add to compare/.test(rows.compare), rows.compare);
      await axeCheck(s, 'open show modal at 1280');

      // Keyboard into a season, then Esc one level back.
      await evaluate(s, `(()=>{ const b = document.querySelector('#showModalSeasons .ss-num'); b.focus(); return 1 })()`);
      await pressKey(s, 'Enter', 'Enter', 13, 0, '\r');
      const seasonOpen = await waitForExpr(s, `!document.getElementById('detailModal').hidden`, { timeout: 8000 });
      t('D9: Enter on the season button opens the season modal', seasonOpen);
      await axeCheck(s, 'open season modal at 1280');
      await pressKey(s, 'Escape', 'Escape', 27);
      await sleep(500);
      const afterEsc = await evaluate(s, `JSON.stringify({ season: !document.getElementById('detailModal').hidden,
        show: !document.getElementById('showModal').hidden, hash: location.hash })`);
      t('D5: Esc in a season opened from a show returns to the show modal',
        !afterEsc.season && afterEsc.show && afterEsc.hash === `#show=${SHOW}`, JSON.stringify(afterEsc));
      await pressKey(s, 'Escape', 'Escape', 27);
      await sleep(400);
      t('D5: a second Esc closes the show modal', await evaluate(s, `document.getElementById('showModal').hidden && location.hash === ''`),
        await evaluate(s, 'location.hash'));
      t('no JS errors through the modal flow', cleanErrors(s).length === 0, cleanErrors(s).slice(0, 2).join(' | '));
    } catch (e) {
      t('rising-shows audit: section completed', false, String(e && e.message || e));
    } finally { await closePage(cdpPort, s); }
  }

  /* ------------------------------------------------- 5. detail 404 (D7) */
  {
    const s = await fresh();
    try {
      await s.send('Network.enable');
      await s.send('Network.setCacheDisabled', { cacheDisabled: true });
      let block = true;
      await interceptNetwork(s, (url) => (block && /\/data\/detail\//.test(url) ? { status: 404, body: 'not found', contentType: 'text/plain' } : null));
      await open(s, `#show=${SHOW}`);
      await waitForExpr(s, `!document.getElementById('showModal').hidden && !!document.querySelector('#showModalSeasons > li')`, { timeout: 15000 });
      const failed = await evaluate(s, `(()=>{ const line = document.querySelector('#showModal .modal-detail-error');
        return JSON.stringify({ line: line ? line.textContent : null, retry: !!(line && line.querySelector('.modal-detail-retry')),
          eps: [...document.querySelectorAll('#showModalSeasons .ss-eps')].map(e => e.textContent),
          stats: document.getElementById('showModalStats').textContent }); })()`);
      t('D7: a 404 detail file shows a retry line in the show modal', /could not be loaded/.test(failed.line || '') && failed.retry, failed.line);
      t('D7: season rows keep the index episode counts instead of "0 eps"',
        failed.eps.length > 0 && failed.eps.every((e) => /^[1-9]\d* eps/.test(e)), failed.eps.join(' | '));
      t('D7: the stats line never claims 0 episodes', !/\b0 episodes/.test(failed.stats), failed.stats);
      block = false;
      await clickSel(s, '#showModal .modal-detail-retry', { settle: 1500 });
      const recovered = await waitForExpr(s, `!document.querySelector('#showModal .modal-detail-error')`, { timeout: 10000 });
      t('D7: Retry refetches and clears the line', recovered);
      t('no JS errors with a failing detail fetch', cleanErrors(s).length === 0, cleanErrors(s).slice(0, 2).join(' | '));
    } catch (e) {
      t('rising-shows audit: section completed', false, String(e && e.message || e));
    } finally { await closePage(cdpPort, s); }
  }

  /* --------------------------------------------- 6. malformed index (D4) */
  for (const [label, body, want] of [
    ['an empty array', '[]', /Unexpected data shape/],
    ['null-title records', '{"matches":[{"seriesId":"tt1","title":null,"season":1}]}', /Show data is empty/],
  ]) {
    const s = await fresh();
    try {
      await s.send('Network.enable');
      await s.send('Network.setCacheDisabled', { cacheDisabled: true });
      await interceptNetwork(s, (url) => (/data-index\.json/.test(url) ? { status: 200, body } : null));
      await setViewport(s, 1280, 900);
      await goto(s, `${base}${APP}`, { settle: 300 });
      const panel = await waitForExpr(s, `/Couldn't load show data/.test(document.getElementById('finderResults').textContent)`, { timeout: 10000 });
      const text = await evaluate(s, `document.getElementById('finderResults').textContent`);
      const retry = await evaluate(s, `!!document.querySelector('#finderResults button')`);
      t(`D4: ${label} reaches the error panel with Retry`, panel && want.test(text) && retry, text.slice(0, 120));
      t(`D4: ${label} leaves no skeleton and no loading line`, await evaluate(s, `document.querySelectorAll('.skeleton').length === 0 && document.getElementById('finderCount').textContent === ''`));
    } catch (e) {
      t('rising-shows audit: section completed', false, String(e && e.message || e));
    } finally { await closePage(cdpPort, s); }
  }

  /* --------------------------------------------- 7. mobile 390 (U3 U5 U6) */
  {
    const s = await fresh();
    try {
      await open(s, '', { w: 390, h: 844, mobile: true });
      await axeCheck(s, 'finder with results at 390');
      const rail = await evaluate(s, `(()=>{ const d = document.querySelector('.shapes-collapsible'); const nav = document.getElementById('finderShapes');
        const card = document.querySelector(${JSON.stringify(CARD)}); const sum = d && d.querySelector('summary');
        return JSON.stringify({ open: d ? d.open : null, navVisible: nav.checkVisibility(), sumH: sum ? sum.getBoundingClientRect().height : 0,
          cardTop: Math.round(card.getBoundingClientRect().top + scrollY), overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth }); })()`);
      t('U5: the shape rail is collapsed behind a pill on a phone', rail.open === false && rail.navVisible === false && rail.sumH > 0, JSON.stringify(rail));
      t('U5: the first result sits within ~900 px of the top', rail.cardTop < 900, `${rail.cardTop}px`);
      t('mobile: no horizontal overflow', !rail.overflow);
      await clickSel(s, '.shapes-collapsible > summary', { settle: 500 });
      const opened = await evaluate(s, `document.querySelector('.shapes-collapsible').open && document.querySelectorAll('#finderShapes .shape-chip').length > 3`);
      t('U5: tapping the pill expands the rail', opened);
      const mask = await evaluate(s, `(()=>{ const el = document.querySelector('.genre-quick-row') || document.querySelector('.decade-row'); if (!el) return null;
        const cs = getComputedStyle(el); return (cs.maskImage || cs.webkitMaskImage || 'none'); })()`);
      t('U6: horizontally scrolling chip rows carry an edge fade', typeof mask === 'string' && /gradient/.test(mask), String(mask).slice(0, 60));

      await open(s, `#show=${SHOW}`, { w: 390, h: 844, mobile: true });
      await waitForExpr(s, `!document.getElementById('showModal').hidden && !!document.querySelector('#showModalSeasons > li')`, { timeout: 15000 });
      await axeCheck(s, 'open show modal at 390');
      await evaluate(s, `(()=>{ const p = document.querySelector('#showModal .modal-panel'); p.scrollTop = 1200; return p.scrollTop })()`);
      await sleep(400);
      const close = await evaluate(s, `(()=>{ const b = document.querySelector('#showModal .modal-close'); const r = b.getBoundingClientRect();
        const p = document.querySelector('#showModal .modal-panel');
        const hit = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2);
        return JSON.stringify({ scrolled: p.scrollTop, top: Math.round(r.top), hitIsClose: !!(hit && (hit === b || b.contains(hit))) }); })()`);
      t('U3: the close button stays on screen after scrolling the panel and is the element under its own centre',
        close.scrolled > 600 && close.top >= 0 && close.top < 120 && close.hitIsClose, JSON.stringify(close));
      if (!close.hitIsClose) await shot(s, 'u3-sticky-close-390');
    } catch (e) {
      t('rising-shows audit: section completed', false, String(e && e.message || e));
    } finally { await closePage(cdpPort, s); }
  }

  /* --------------------------------------------------- 8. Kometa builder */
  {
    const s = await fresh();
    try {
      await setViewport(s, 1280, 900);
      await goto(s, `${base}${APP}kometa/`, { settle: 500 });
      const loaded = await waitForExpr(s, `document.querySelectorAll('input[type=checkbox]').length >= 5 && !/Loading/i.test((document.querySelector('output,.kometa-status,[role=status]')||{textContent:''}).textContent)`, { timeout: 60000 });
      t('kometa builder loads its data', loaded);
      await axeCheck(s, 'Kometa builder at 1280');
      await setViewport(s, 390, 844, true);
      await sleep(300);
      await axeCheck(s, 'Kometa builder at 390');
      t('kometa: no JS errors', cleanErrors(s).length === 0, cleanErrors(s).slice(0, 2).join(' | '));
    } catch (e) {
      t('rising-shows audit: section completed', false, String(e && e.message || e));
    } finally { await closePage(cdpPort, s); }
  }

  /* ------------------------------------------------ 9. built SEO page smoke */
  {
    const pagePath = path.join(REPO, 'apps', 'rising-shows', 'shows', `breaking-bad-${SHOW}`, 'index.html');
    if (!(await exists(pagePath))) {
      skip('SEO page: built show page renders clean', 'shows/ not built - run `npm run build:rising-shows:pages`');
    } else {
      const manifest = JSON.parse(await readFile(path.join(REPO, 'assets', 'apps-manifest.json'), 'utf8'));
      const s = await fresh();
      try {
        await setViewport(s, 1280, 900);
        await goto(s, `${base}${APP}shows/breaking-bad-${SHOW}/`, { settle: 1200 });
        const info = await evaluate(s, `JSON.stringify({ title: document.title,
          footerApps: [...document.querySelectorAll('.footer-more a[href^="/apps/"]')].map(a => a.getAttribute('href')),
          overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth })`);
        t('SEO page: built show page renders clean (no console errors)', cleanErrors(s).length === 0, cleanErrors(s).slice(0, 2).join(' | '));
        t('SEO page: footer lists every app from the manifest', info.footerApps.length === manifest.apps.length, `${info.footerApps.length} of ${manifest.apps.length}`);
        await setViewport(s, 390, 844, true);
        await sleep(300);
        t('SEO page: no horizontal overflow at 390', !(await evaluate(s, `document.documentElement.scrollWidth > document.documentElement.clientWidth`)));
      } finally { await closePage(cdpPort, s); }
    }
  }

  return R;
}
