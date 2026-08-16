// Visual regression suite: deterministic computed geometry and computed
// styles, not pixel snapshots.
//
// WHY NOT PIXEL BASELINES: committed PNG baselines were considered and
// rejected for this repo. Font rasterization differs between machines (WSL2
// vs CI images vs macOS), so pixel-diffing against committed screenshots
// flakes on every environment change and trains people to re-bless diffs
// blindly. Instead this suite asserts things that are identical on any
// machine at a fixed viewport: element geometry relations (overflow, column
// counts, containment, stacking) and computed style values (background and
// text colors, the main.css collision gray). Those catch the real regression
// classes - layout breakage, theme bleed, the site-wide button trap - without
// a single environment-dependent pixel.
//
// The specific hazard this suite guards: assets/css/main.css ships
// `button { color:#555555 !important }` plus a red :hover and a red input
// focus ring. Any app button whose own CSS does not counter-pin its color is
// silently repainted gray (documented repo hazard; a past theme-audit round
// fixed many). The "collision pin" checks below sample each app's primary
// controls and fail if the main.css gray ever wins again.
//
// All thresholds below were calibrated against the live pages on 2026-08-15;
// every check passes on today's code. Tolerances are relations and bounds,
// never exact pixel positions.
import {
  newPage, closePage, goto, evaluate, setViewport, clickSel, clickText,
  waitForExpr, sleep, interceptNetwork,
} from '../cdp.mjs';

const ROOT_PAGES = ['home', 'work', 'apps', 'about', 'contact', 'privacy', '404', 'moadon-alef'];

// Same production-protection list as suites/apps.mjs and suites/a11y.mjs.
const FIREBASE_HOSTS = /firestore\.googleapis\.com|firebaseio\.com|identitytoolkit\.googleapis\.com|securetoken\.googleapis\.com/i;
// moadon-alef is a separately branded landing with deliberately no site
// header (site.mjs documents the decision), so it is excluded from the
// shared-chrome geometry checks but still swept for overflow.
const CHROME_ROOT_PAGES = ROOT_PAGES.filter((p) => p !== 'moadon-alef');
const APPS = ['arena', 'football-h2h', 'fpl-planner', 'gym-tracker', 'maptap-rivals', 'mario-kart', 'rising-shows', 'trip-planner'];

// rising-shows boots a large dataset (when fetched); give it longer to settle
// so late renders cannot shift geometry mid-measurement.
const settleFor = (app) => (app === 'rising-shows' ? 5000 : 2200);

// Per-app element whose computed color is the app's effective body text.
// fpl-planner and trip-planner leave document.body at main.css's dark #444
// and repaint text on their own root wrapper, so probing body there would
// report a false dark-on-dark failure.
const TEXT_PROBE = {
  'arena': 'main.page',
  'football-h2h': 'body',
  'fpl-planner': '.fpl-planner-app',
  'gym-tracker': '.app-container',
  'maptap-rivals': 'main.page',
  'mario-kart': 'body',
  'rising-shows': 'main.page',
  'trip-planner': '.trip-planner-app',
};

// main.css collision pins: 1-2 stable primary controls per app, chosen from
// each app's real markup. Calibrated 2026-08-15: every one of these computes
// to its app's own pinned color (whites / near-whites / arena's deliberate
// dark-on-gradient rgb(5,27,34), rising-shows' gold rgb(245,197,24)), and
// NONE computes to the main.css gray. No app currently loses this fight, so
// there are no KNOWN DEFECT skips here; a new gray reading is a regression.
const PIN_SELECTORS = {
  'arena': ['#create-room-btn', '#play-solo-btn'],
  'football-h2h': ['#sidebar-add-game-btn', '#sidebar-toggle'],
  'fpl-planner': ['#fpl-onboard-go', '.fpl-btn'],
  'gym-tracker': ['.nav-links .nav-link', '.btn-primary'],
  'maptap-rivals': ['#add-rival-btn', '.view-tab'],
  'mario-kart': ['#sidebar-add-race-btn', '.toggle-btn'],
  'rising-shows': ['#finderSurprise', '.shape-chip'],
  'trip-planner': ['#addBtn', '#viewTimeline'],
};
const MAIN_CSS_GRAY = 'rgb(85, 85, 85)';

const OVERFLOW_EXPR = 'document.documentElement.scrollWidth - document.documentElement.clientWidth';

// Theme integrity, evaluated in-page. Effective page background is body's
// unless body is transparent (some apps paint html instead). Luminance
// thresholds: measured backgrounds are all L < 0.1 (darkest theme tokens),
// measured text probes all L > 0.85, so 0.35 / 0.55 leave wide margins while
// still failing hard on an accidental light theme or unstyled text.
const THEME_EXPR = (textSel) => `(()=>{
  const lum=(c)=>{const m=String(c).match(/rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)(?:,\\s*([\\d.]+))?\\)/);
    if(!m) return null; const a=m[4]===undefined?1:parseFloat(m[4]);
    return {a, L:(0.2126*m[1]+0.7152*m[2]+0.0722*m[3])/255};};
  const bodyBg=getComputedStyle(document.body).backgroundColor;
  const htmlBg=getComputedStyle(document.documentElement).backgroundColor;
  const bl=lum(bodyBg);
  const eff=(bl&&bl.a>0.1)?bodyBg:htmlBg;
  const bg=lum(eff);
  const tEl=document.querySelector(${JSON.stringify(textSel)});
  const txt=tEl?lum(getComputedStyle(tEl).color):null;
  // Unexpected light panels: large opaque near-white surfaces anywhere near
  // the wrapper level (depth-limited scan; the repo is dark-theme-only, so a
  // big white panel is always theme bleed). Calibrated: zero on every app.
  const light=[];
  const scan=(el,depth)=>{ if(depth>3) return;
    for(const c of el.children){ if(c.id==='header'||c.id==='footer') continue;
      const r=c.getBoundingClientRect();
      if(r.width*r.height>50000){ const l=lum(getComputedStyle(c).backgroundColor);
        if(l&&l.a>0.5&&l.L>0.8) light.push(c.tagName+'#'+(c.id||'')+'.'+String(c.className).slice(0,40)); }
      scan(c,depth+1); } };
  scan(document.body,0);
  return { effBg:eff, bgL:bg?+bg.L.toFixed(3):null, txtCol:tEl?getComputedStyle(tEl).color:null,
    txtL:txt?+txt.L.toFixed(3):null, lightPanels:light.slice(0,5) };})()`;

// Shared chrome geometry: header pinned at the top with real height, footer
// laid out below it, and the top of the header actually hit-testable (an
// overlay that paints over the header would swallow its clicks; probed at
// three x positions with real elementFromPoint, which element.click() style
// probes cannot see).
const CHROME_EXPR = `(()=>{
  window.scrollTo(0,0);
  const H=document.getElementById('header'), F=document.getElementById('footer');
  if(!H||!F) return {header:!!H,footer:!!F};
  const r=H.getBoundingClientRect(), f=F.getBoundingClientRect();
  let hits=[];
  if(r.height>0){ hits=[[r.left+15,r.top+r.height/2],[r.left+r.width/2,r.top+r.height/2],[r.right-15,r.top+r.height/2]]
    .map(([x,y])=>{const e=document.elementFromPoint(x,y);
      return e&&H.contains(e)?'header':(e?(e.id||String(e.className).slice(0,30)||e.tagName):'null');}); }
  return { header:true, footer:true, hTop:Math.round(r.top), hH:Math.round(r.height),
    fTop:Math.round(f.top), hBottom:Math.round(r.bottom), hits };})()`;

// Inner-container overflow leaks at 390px: elements with internal horizontal
// overflow that are not inside any scroll/clip container (body-level
// overflow-x hidden does not count as containment - content clipped at the
// viewport edge is exactly the bug) and whose box extends past the viewport.
// This catches the class the root scrollWidth metric misses: a table or code
// block poking off-screen inside a page that technically does not scroll.
// Calibrated 2026-08-15: zero offenders in all eight apps, so there is no
// current-state allowlist; any offender this reports is new.
const INNER_LEAK_EXPR = `(()=>{
  const vw=document.documentElement.clientWidth;
  const contained=(el)=>{ for(let p=el;p && p!==document.body && p!==document.documentElement;p=p.parentElement){
    const o=getComputedStyle(p).overflowX;
    if(o==='auto'||o==='scroll'||o==='hidden'||o==='clip') return true; } return false; };
  const bad=[];
  for(const el of document.querySelectorAll('body *')){
    if(el.closest('#header,#footer')) continue;
    if(el.scrollWidth>el.clientWidth+2){ const r=el.getBoundingClientRect();
      if(r.width>0 && r.right>vw+2 && !contained(el)){
        bad.push(el.tagName+'#'+(el.id||'')+'.'+String(el.className).slice(0,40)); } } }
  return bad.slice(0,8); })()`;

export async function run({ base, cdpPort }) {
  const R = [];
  const t = (name, pass, detail = '') => R.push({ name, pass: !!pass, detail });

  const s = await newPage(cdpPort);
  // Session-wide production protection, same rule as apps.mjs/a11y.mjs:
  // arena is one of the app roots this suite loads, and no page here may
  // ever reach real Firebase. Geometry assertions are unaffected.
  await interceptNetwork(s, (url) => (FIREBASE_HOSTS.test(url) ? 'fail' : null));
  try {
    /* ------------------- desktop 1280x900: root pages ------------------- */
    try {
      await setViewport(s, 1280, 900);
      for (const p of ROOT_PAGES) {
        await goto(s, `${base}/${p}.html`, { settle: 2200 });
        const over = await evaluate(s, OVERFLOW_EXPR);
        t(`visual desktop ${p}: no horizontal overflow`, over <= 1, `${over}px`);
        if (CHROME_ROOT_PAGES.includes(p)) {
          const c = await evaluate(s, CHROME_EXPR);
          const ok = c && c.header && c.footer && c.hH >= 20 && c.hTop >= -2 && c.hTop <= 80
            && c.fTop > c.hBottom && Array.isArray(c.hits) && c.hits.every((h) => h === 'header');
          t(`visual desktop ${p}: header/footer geometry sound`, ok, JSON.stringify(c));
        }
      }
    } catch (e) { t('visual desktop root pages: block ran', false, String(e && e.message).slice(0, 140)); }

    /* -------------------- desktop 1280x900: app roots ------------------- */
    try {
      await setViewport(s, 1280, 900);
      for (const a of APPS) {
        await goto(s, `${base}/apps/${a}/`, { settle: settleFor(a) });
        // gym-tracker's first-run onboarding modal (z-index 2000) covers the
        // site header; dismiss it the way a user does before geometry checks.
        // The click is a no-op when storage already marks onboarding seen.
        if (a === 'gym-tracker') {
          await waitForExpr(s, '!!window.gymApp');
          await clickText(s, 'Skip tour', { settle: 800 });
        }
        const over = await evaluate(s, OVERFLOW_EXPR);
        t(`visual desktop app ${a}: no horizontal overflow`, over <= 1, `${over}px`);

        const th = await evaluate(s, THEME_EXPR(TEXT_PROBE[a]));
        const themeOk = th && th.bgL !== null && th.bgL < 0.35
          && th.txtL !== null && th.txtL > 0.55 && th.lightPanels.length === 0;
        t(`visual theme ${a}: dark background, light text, no light panels`, themeOk, JSON.stringify(th));

        const pins = await evaluate(s, `(()=>${JSON.stringify(PIN_SELECTORS[a])}.map(sel=>{
          const el=document.querySelector(sel);
          return { sel, found:!!el, color: el?getComputedStyle(el).color:null };}))()`);
        const found = pins.filter((p) => p.found);
        const pinsOk = found.length >= 1 && found.every((p) => p.color !== MAIN_CSS_GRAY);
        t(`visual pins ${a}: primary controls not defeated by main.css gray`, pinsOk, JSON.stringify(pins));

        const c = await evaluate(s, CHROME_EXPR);
        const chromeOk = c && c.header && c.footer && c.hH >= 20 && c.hTop >= -2 && c.hTop <= 80
          && c.fTop > c.hBottom && Array.isArray(c.hits) && c.hits.every((h) => h === 'header');
        t(`visual desktop app ${a}: header/footer geometry sound`, chromeOk, JSON.stringify(c));
      }
    } catch (e) { t('visual desktop app roots: block ran', false, String(e && e.message).slice(0, 140)); }

    /* -------------- desktop 1280: apps hub grid structure --------------- */
    try {
      await setViewport(s, 1280, 900);
      await goto(s, `${base}/apps.html`, { settle: 2000 });
      const grid = await evaluate(s, `(()=>[...document.querySelectorAll('.highlights section[data-category]')]
        .map(c=>{const r=c.getBoundingClientRect();return {t:Math.round(r.top),b:Math.round(r.bottom)};}))()`);
      // Multi-column means at least one row where two cards share a top edge.
      const rows = {};
      for (const c of grid) { const key = Math.round(c.t / 10); rows[key] = (rows[key] || 0) + 1; }
      const multiCol = Object.values(rows).some((n) => n >= 2);
      t('visual apps hub 1280: >= 8 cards in a multi-column grid',
        grid.length >= 8 && multiCol, `${grid.length} cards, row sizes ${Object.values(rows).join(',')}`);
    } catch (e) { t('visual apps hub desktop grid: block ran', false, String(e && e.message).slice(0, 140)); }

    /* ---------------------- tablet 768x1024: app roots ------------------ */
    // Apps never had tablet coverage anywhere else; overflow is the highest
    // value low-flake assertion at this width.
    try {
      await setViewport(s, 768, 1024);
      for (const a of APPS) {
        await goto(s, `${base}/apps/${a}/`, { settle: settleFor(a) });
        const over = await evaluate(s, OVERFLOW_EXPR);
        t(`visual tablet app ${a}: no horizontal overflow`, over <= 1, `${over}px`);
      }
    } catch (e) { t('visual tablet app roots: block ran', false, String(e && e.message).slice(0, 140)); }

    /* ---------------- mobile 390x844 (touch): root pages ---------------- */
    try {
      await setViewport(s, 390, 844, true);
      for (const p of ROOT_PAGES) {
        await goto(s, `${base}/${p}.html`, { settle: 2200 });
        const over = await evaluate(s, OVERFLOW_EXPR);
        t(`visual mobile ${p}: no horizontal overflow`, over <= 1, `${over}px`);
        if (p === 'home') {
          const cta = await evaluate(s, `(()=>{
            const row=document.querySelector('.hero .cta-row'); if(!row) return null;
            const r=row.getBoundingClientRect(); const vw=document.documentElement.clientWidth;
            const btns=[...row.querySelectorAll('.button')].map(b=>b.getBoundingClientRect());
            return { rowL:Math.round(r.left), rowR:Math.round(r.right), vw,
              btnsInside: btns.length>0 && btns.every(b=>b.left>=-2 && b.right<=vw+2) };})()`);
          t('visual mobile home: hero CTA row fits the viewport',
            cta && cta.rowL >= -2 && cta.rowR <= cta.vw + 2 && cta.btnsInside, JSON.stringify(cta));
        }
        if (p === 'apps') {
          const grid = await evaluate(s, `(()=>[...document.querySelectorAll('.highlights section[data-category]')]
            .map(c=>{const r=c.getBoundingClientRect();return {t:Math.round(r.top),b:Math.round(r.bottom)};})
            .sort((x,y)=>x.t-y.t))()`);
          // Single column = strictly stacked: each card starts below the one
          // before it. Left edges differ by design (one card is full-bleed),
          // so column count is asserted on stacking, not x positions.
          let stacked = grid.length >= 8;
          for (let i = 1; i < grid.length; i++) if (grid[i].t < grid[i - 1].b - 5) stacked = false;
          t('visual mobile apps hub: cards stack in a single column',
            stacked, `${grid.length} cards, tops ${grid.map((g) => g.t).join(',')}`);
        }
      }
    } catch (e) { t('visual mobile root pages: block ran', false, String(e && e.message).slice(0, 140)); }

    /* ----------------- mobile 390x844 (touch): app roots ----------------- */
    try {
      await setViewport(s, 390, 844, true);
      for (const a of APPS) {
        await goto(s, `${base}/apps/${a}/`, { settle: settleFor(a) });
        const over = await evaluate(s, OVERFLOW_EXPR);
        t(`visual mobile app ${a}: no horizontal overflow`, over <= 1, `${over}px`);
        const leaks = await evaluate(s, INNER_LEAK_EXPR);
        t(`visual mobile app ${a}: no uncontained inner overflow leaks`,
          Array.isArray(leaks) && leaks.length === 0, leaks && leaks.length ? leaks.join(' | ') : '');
      }
    } catch (e) { t('visual mobile app roots: block ran', false, String(e && e.message).slice(0, 140)); }

    /* ------------- modal surfaces at 390x844 stay in-viewport ------------ */
    // gym-tracker: Programs view -> Create Program opens #program-modal.
    try {
      await setViewport(s, 390, 844, true);
      await goto(s, `${base}/apps/gym-tracker/`, { settle: 2200 });
      await waitForExpr(s, '!!window.gymApp');
      await clickText(s, 'Skip tour', { settle: 800 });
      await clickSel(s, '.bottom-nav .nav-item[data-view="programs"]', { settle: 900 });
      await clickSel(s, '#create-program-btn', { settle: 900 });
      const gym = await evaluate(s, `(()=>{
        const m=document.getElementById('program-modal'); if(!m) return null;
        const mr=m.getBoundingClientRect();
        const c=m.querySelector('.modal-content, .modal-dialog, form')||m.firstElementChild;
        const cr=c&&c.getBoundingClientRect();
        const vw=document.documentElement.clientWidth, vh=document.documentElement.clientHeight;
        return { active:m.classList.contains('active'),
          overlayCovers: mr.left<=1&&mr.top<=1&&mr.right>=vw-1&&mr.bottom>=vh-1,
          content: cr?{l:Math.round(cr.left),t:Math.round(cr.top),r:Math.round(cr.right),b:Math.round(cr.bottom)}:null,
          inViewport: !!cr && cr.left>=-2 && cr.top>=-2 && cr.right<=vw+2 && cr.bottom<=vh+2 };})()`);
      t('visual mobile gym-tracker: program modal opens inside the viewport',
        gym && gym.active && gym.inViewport, JSON.stringify(gym));
      t('visual mobile gym-tracker: program modal overlay covers the viewport',
        gym && gym.overlayCovers, JSON.stringify(gym && { overlayCovers: gym.overlayCovers }));
    } catch (e) { t('visual mobile gym-tracker modal: block ran', false, String(e && e.message).slice(0, 140)); }

    // trip-planner: Add item opens #itemForm inside the #itemOverlay backdrop.
    try {
      await setViewport(s, 390, 844, true);
      await goto(s, `${base}/apps/trip-planner/`, { settle: 2200 });
      await clickText(s, 'Add item', { settle: 1200 });
      const trip = await evaluate(s, `(()=>{
        const f=document.getElementById('itemForm'), o=document.getElementById('itemOverlay');
        if(!f) return null;
        const fr=f.getBoundingClientRect();
        const or2=o&&o.getBoundingClientRect();
        const vw=document.documentElement.clientWidth, vh=document.documentElement.clientHeight;
        return { form:{l:Math.round(fr.left),t:Math.round(fr.top),r:Math.round(fr.right),b:Math.round(fr.bottom)},
          inViewport: fr.height>100 && fr.left>=-2 && fr.top>=-2 && fr.right<=vw+2 && fr.bottom<=vh+2,
          overlayCovers: !!or2 && or2.left<=1 && or2.top<=1 && or2.right>=vw-1 && or2.bottom>=vh-1 };})()`);
      t('visual mobile trip-planner: Add-item dialog opens inside the viewport',
        trip && trip.inViewport, JSON.stringify(trip));
      t('visual mobile trip-planner: Add-item overlay covers the viewport',
        trip && trip.overlayCovers, JSON.stringify(trip && { overlayCovers: trip.overlayCovers }));
    } catch (e) { t('visual mobile trip-planner modal: block ran', false, String(e && e.message).slice(0, 140)); }
  } finally {
    await closePage(cdpPort, s);
  }
  return R;
}
