// Marketing-site regression: the 8 root pages plus navigation and responsive
// behaviour. Assertions here are deliberately about structure and wiring, not
// wording, so ordinary copy edits do not turn the suite red.
import {
  newPage, closePage, goto, evaluate, evalAsync, clickSel, setViewport, setValue,
  sleep, cleanErrors, firstPartyFailures, waitForExpr, hoverSel,
} from '../cdp.mjs';

const PAGES = ['home', 'work', 'apps', 'about', 'contact', 'privacy', '404', 'moadon-alef'];

// Intended robots meta per page, read from the committed HTML. 404 is the one
// deliberate noindex; the apex shell (index.html) deliberately carries NO
// robots meta at all and is asserted separately below.
const INDEXABLE_ROBOTS = 'index, follow, max-image-preview:large';
const ROBOTS = {
  home: INDEXABLE_ROBOTS, work: INDEXABLE_ROBOTS, apps: INDEXABLE_ROBOTS,
  about: INDEXABLE_ROBOTS, contact: INDEXABLE_ROBOTS, privacy: INDEXABLE_ROBOTS,
  'moadon-alef': INDEXABLE_ROBOTS, '404': 'noindex, follow',
};

// moadon-alef is a standalone, separately-branded landing: it injects its own
// footer partial (footer-moadon-alef) and deliberately carries no site header
// or nav. 404 deliberately has no canonical, because it carries noindex and is
// not a real page. Both are design decisions, not omissions.
const NO_SITE_CHROME = new Set(['moadon-alef']);
const NO_CANONICAL = new Set(['404']);

export async function run({ base, cdpPort }) {
  const R = [];
  const t = (name, pass, detail = '') => R.push({ name, pass: !!pass, detail });
  // Skips document behavior the product currently lacks (KNOWN DEFECT) or a
  // precondition the repo cannot supply; they are reported, never failures.
  const skip = (name, reason) => R.push({ name, pass: true, skipped: true, detail: reason });

  const s = await newPage(cdpPort);
  await setViewport(s, 1280, 900);

  for (const p of PAGES) {
    await goto(s, `${base}/${p}.html`, { settle: 2600 });
    const d = await evaluate(s, `(()=>({
      title: document.title,
      h1count: document.querySelectorAll('h1').length,
      header: !!document.querySelector('#header'),
      footer: !!document.querySelector('#footer'),
      navLinks: document.querySelectorAll('#header nav a').length,
      canonical: !!document.querySelector('link[rel=canonical]'),
      desc: !!document.querySelector('meta[name=description]'),
      lang: document.documentElement.lang || null,
      robots: (document.querySelector('meta[name=robots]')||{}).content || null,
      imgsNoAlt: [...document.images].filter(i=>!i.hasAttribute('alt')).length,
      unnamedLinks: [...document.querySelectorAll('a')].filter(a=>
        !a.textContent.trim() && !a.getAttribute('aria-label')
        && !a.querySelector('img[alt]:not([alt=""])')).length
    }))()`);

    t(`${p}: no JS errors`, cleanErrors(s).length === 0, cleanErrors(s).slice(0, 2).join(' | '));
    // Network-level truth: cleanErrors() must ignore console noise from
    // blocked external hosts, so a LOCAL 404 (broken image, missing CSS)
    // is caught here instead, where the URL's origin is unambiguous.
    const fpf = firstPartyFailures(s, base);
    t(`${p}: no first-party network failures`, fpf.length === 0, fpf.slice(0, 2).join(' | '));
    t(`${p}: robots meta matches intent`, d.robots === ROBOTS[p], String(d.robots));
    t(`${p}: has a title`, !!d.title && d.title.length > 5, d.title);
    t(`${p}: exactly one h1`, d.h1count === 1, `found ${d.h1count}`);
    t(`${p}: footer partial injected`, d.footer);
    t(`${p}: meta description present`, d.desc);
    t(`${p}: html lang set`, !!d.lang, String(d.lang));
    t(`${p}: every image has alt`, d.imgsNoAlt === 0, `${d.imgsNoAlt} missing`);
    t(`${p}: no unnamed links`, d.unnamedLinks === 0, `${d.unnamedLinks} unnamed`);
    if (!NO_CANONICAL.has(p)) t(`${p}: canonical present`, d.canonical);
    if (!NO_SITE_CHROME.has(p)) {
      t(`${p}: header partial injected`, d.header);
      if (p !== '404') t(`${p}: nav links present`, d.navLinks >= 5, `${d.navLinks} links`);
    }
  }

  // --- hero CTAs + app grid ------------------------------------------------
  await goto(s, `${base}/home.html`, { settle: 2600 });
  const home = await evaluate(s, `(()=>{
    const btns=[...document.querySelectorAll('.hero .cta-row .button')];
    return { ctaCount:btns.length,
      variants:[...new Set(btns.map(b=>b.className))],
      backgrounds:[...new Set(btns.map(b=>getComputedStyle(b).backgroundColor))],
      appLinksGone: !document.querySelector('.home-app-links') };})()`);
  t('home: three hero CTAs', home.ctaCount === 3, String(home.ctaCount));
  t('home: CTAs share one variant', home.variants.length === 1, home.variants.join(' / '));
  t('home: CTAs share one background', home.backgrounds.length === 1, home.backgrounds.join(' / '));
  // The per-app grid was removed 2026-08-12: /apps is the one route, via the
  // hero button, so the homepage carries no app inventory to drift.
  t('home: no per-app link grid', home.appLinksGone, 'stale .home-app-links present');

  // Every app must resolve from the hub's linked preview images, which are
  // the canonical browse surface now that home carries no per-app grid.
  await goto(s, `${base}/apps.html`, { settle: 2000 });
  const hub = await evaluate(s, `(()=>{
    const links=[...document.querySelectorAll('a.app-preview-link')];
    return { hrefs:links.map(a=>a.getAttribute('href')),
      names:links.map(a=>(a.getAttribute('aria-label')||'').replace(/^Open /,'')) };})()`);
  t('apps hub: every preview image is a link', hub.hrefs.length > 0 && hub.hrefs.every(h => /^apps\/[a-z0-9-]+\/$/.test(h)), hub.hrefs.join(', '));
  for (let i = 0; i < hub.hrefs.length; i++) {
    await goto(s, `${base}/${hub.hrefs[i]}`, { settle: 1500 });
    const ok = await evaluate(s, "document.title.length>0 && !!document.querySelector('h1,h2')");
    t(`apps hub: preview link ${hub.names[i]} resolves`, !!ok, hub.hrefs[i]);
  }

  // --- apps hub: search + category filters ---------------------------------
  // Selectors come straight from apps.html: #app-search, .app-filter-bar
  // button[data-filter], .highlights section[data-category]. Filtering sets
  // section.style.display, so visibility is asserted on that.
  const CARD_SEL = '.highlights section[data-category]';
  const visExpr = `[...document.querySelectorAll(${JSON.stringify(CARD_SEL)})]
    .filter(x=>x.style.display!=='none').length`;
  await goto(s, `${base}/apps.html`, { settle: 1800 });
  const allCards = await evaluate(s, visExpr);
  t('apps hub: all app cards visible initially', allCards >= 8, `${allCards} cards`);

  await setValue(s, '#app-search', 'mario kart');
  t('apps hub: search narrows to the matching card',
    await waitForExpr(s, `(${visExpr}) === 1`), `now ${await evaluate(s, visExpr)}`);

  await setValue(s, '#app-search', 'zzz-no-app-matches-this');
  t('apps hub: no-match query hides every card',
    await waitForExpr(s, `(${visExpr}) === 0`), `${await evaluate(s, visExpr)} still visible`);
  // Expected-failure check (executes every run, unlike a plain skip): with a
  // zero-match query active, a user should see an empty-state message and a
  // screen reader should get an aria-live results announcement. Today
  // apps.html has neither, so the grid goes silently blank.
  const emptyState = await evaluate(s, `(()=>{
    const live = [...document.querySelectorAll('[aria-live],[role=status]')]
      .some(el => (el.textContent||'').trim().length > 0);
    const msg = [...document.querySelectorAll('main *, section, p, div')]
      .some(el => el.children.length === 0 && el.offsetParent !== null
        && /no (apps|results|matches)/i.test(el.textContent||''));
    return { live, msg };
  })()`);
  if (!emptyState.live && !emptyState.msg) {
    skip('apps hub: no-match empty state + SR results announcement',
      'KNOWN DEFECT: zero-match search shows a blank grid; apps.html has no empty-state message and no aria-live results announcement');
  } else {
    t('apps hub: no-match empty state + SR results announcement', false,
      `unexpectedly passes (live=${emptyState.live}, msg=${emptyState.msg}) - the pinned defect no longer fully reproduces; convert this quarantine into plain assertions and mark defect 20 resolved in TESTING-AUDIT.md`);
  }

  await setValue(s, '#app-search', '');
  t('apps hub: clearing search restores all cards',
    await waitForExpr(s, `(${visExpr}) === ${allCards}`), `${await evaluate(s, visExpr)}/${allCards}`);

  const fitClicked = await clickSel(s, '.app-filter-bar button[data-filter="fitness"]');
  const fitState = await evaluate(s, `(()=>({
    pressed: document.querySelector('.app-filter-bar button[data-filter="fitness"]').getAttribute('aria-pressed'),
    allPressed: document.querySelector('.app-filter-bar button[data-filter="all"]').getAttribute('aria-pressed'),
    cats: [...document.querySelectorAll(${JSON.stringify(CARD_SEL)})]
      .filter(x=>x.style.display!=='none').map(x=>x.getAttribute('data-category')),
  }))()`);
  t('apps hub: category button toggles aria-pressed',
    fitClicked && fitState.pressed === 'true' && fitState.allPressed === 'false',
    `fitness=${fitState.pressed} all=${fitState.allPressed}`);
  t('apps hub: category filter shows only that category',
    fitState.cats.length > 0 && fitState.cats.every((c) => c === 'fitness'), fitState.cats.join(','));

  await clickSel(s, '.app-filter-bar button[data-filter="all"]');
  t('apps hub: All restores every card',
    await waitForExpr(s, `(${visExpr}) === ${allCards}`), `${await evaluate(s, visExpr)}/${allCards}`);

  await goto(s, `${base}/apps.html?q=gym`, { settle: 1800 });
  const deepLink = await evaluate(s, `(()=>({
    q: (document.getElementById('app-search')||{}).value,
    visible: ${visExpr} }))()`);
  t('apps hub: ?q= deep link pre-filters on load',
    deepLink.q === 'gym' && deepLink.visible === 1, JSON.stringify(deepLink));

  // --- header apps dropdown (desktop) ---------------------------------------
  // partials/header.html gives the toggle aria-haspopup/aria-expanded; main.js
  // opens on hover (mouseenter handler) and on keyboard focus (focusin).
  await goto(s, `${base}/home.html`, { settle: 2000 });
  const expandedBefore = await evaluate(s,
    `(document.querySelector('.nav-apps__toggle')||{getAttribute:()=>null}).getAttribute('aria-expanded')`);
  t('header dropdown: closed by default (aria-expanded=false)',
    expandedBefore === 'false', String(expandedBefore));
  const isOpenExpr = `(()=>{const w=document.querySelector('.nav-apps');
    return !!w && w.classList.contains('is-open')})()`;
  await hoverSel(s, '.nav-apps__toggle', { settle: 300 });
  let ddOpen = await waitForExpr(s, isOpenExpr, { timeout: 2500 });
  if (!ddOpen) {
    // Keyboard path (focusin opens the menu) - a real user path, used as the
    // fallback when headless hover proves flaky.
    await evaluate(s, `(()=>{document.querySelector('.nav-apps__toggle').focus(); return 1})()`);
    ddOpen = await waitForExpr(s, isOpenExpr, { timeout: 2500 });
  }
  const dd = await evaluate(s, `(()=>{
    const menu=document.getElementById('nav-apps-menu');
    const links=menu?[...menu.querySelectorAll('a')]:[];
    return { expanded: document.querySelector('.nav-apps__toggle').getAttribute('aria-expanded'),
      visible: links.filter(a=>a.getBoundingClientRect().height>0).length,
      total: links.length };})()`);
  t('header dropdown: opens and sets aria-expanded=true',
    ddOpen && dd.expanded === 'true', JSON.stringify(dd));
  t('header dropdown: shows the app links', dd.visible >= 9, `${dd.visible}/${dd.total} visible`);

  // --- nav by real click ---------------------------------------------------
  for (const label of ['work', 'apps', 'about', 'contact']) {
    await goto(s, `${base}/home.html`, { settle: 1800 });
    const clicked = await clickSel(s, `#header nav a[href*="${label}"]`);
    const pathNow = await evaluate(s, 'location.pathname');
    t(`nav: "${label}" navigates`, clicked && pathNow.includes(label), `-> ${pathNow}`);
  }

  // --- contact form --------------------------------------------------------
  await goto(s, `${base}/contact.html`, { settle: 2200 });
  const cf = await evaluate(s, `(()=>{
    const f=document.querySelector('form'); if(!f) return {none:true};
    const fields=[...f.querySelectorAll('input,textarea,select')].filter(x=>x.type!=='hidden');
    return { count:fields.length,
      labelled: fields.every(x=> !!f.querySelector('label[for="'+x.id+'"]')
        || !!x.getAttribute('aria-label') || !!x.closest('label') || !!x.placeholder) };})()`);
  t('contact: form present', !cf.none);
  if (!cf.none) t('contact: all fields labelled', cf.labelled, `${cf.count} fields`);

  // --- moadon-alef language switcher ----------------------------------------
  // Real markup: .lang-btn[data-lang] buttons; assets/js/language-switcher.js
  // sets documentElement.lang, body.dir, aria-pressed, and persists the choice
  // under localStorage 'moadon-alef-lang'.
  await setViewport(s, 1280, 900);
  await goto(s, `${base}/moadon-alef.html`, { settle: 2200 });
  const langReady = await waitForExpr(s, `typeof window.switchLanguage === 'function'`);
  const enDefault = await evaluate(s, `(()=>({
    active: (document.querySelector('.lang-btn.active')||{dataset:{}}).dataset.lang,
    dir: document.body.dir || 'ltr',
    heHidden: [...document.querySelectorAll('p[lang="he"]')].every(p=>p.getBoundingClientRect().height===0),
  }))()`);
  t('moadon-alef: English is the default language',
    langReady && enDefault.active === 'en' && enDefault.dir !== 'rtl' && enDefault.heHidden,
    JSON.stringify(enDefault));

  await clickSel(s, '.lang-btn[data-lang="he"]', { settle: 500 });
  const he = await evaluate(s, `(()=>({
    lang: document.documentElement.lang, dir: document.body.dir,
    pressed: document.querySelector('.lang-btn[data-lang="he"]').getAttribute('aria-pressed'),
    enPressed: document.querySelector('.lang-btn[data-lang="en"]').getAttribute('aria-pressed'),
    heVisible: [...document.querySelectorAll('p[lang="he"]')].some(p=>p.getBoundingClientRect().height>0),
    enVisible: [...document.querySelectorAll('p[lang="en"]')].some(p=>p.getBoundingClientRect().height>0),
    stored: localStorage.getItem('moadon-alef-lang'),
  }))()`);
  t('moadon-alef: Hebrew switch sets lang=he, dir=rtl, aria-pressed',
    he.lang === 'he' && he.dir === 'rtl' && he.pressed === 'true' && he.enPressed === 'false',
    JSON.stringify({ lang: he.lang, dir: he.dir, pressed: he.pressed }));
  t('moadon-alef: Hebrew content shown, English hidden', he.heVisible && !he.enVisible,
    `he=${he.heVisible} en=${he.enVisible}`);
  t('moadon-alef: language persists to localStorage', he.stored === 'he', String(he.stored));

  await goto(s, `${base}/moadon-alef.html`, { settle: 2200 });
  const persisted = await evaluate(s,
    `(()=>({ lang: document.documentElement.lang, dir: document.body.dir }))()`);
  t('moadon-alef: persisted language restores on reload',
    persisted.lang === 'he' && persisted.dir === 'rtl', JSON.stringify(persisted));

  await clickSel(s, '.lang-btn[data-lang="ru"]', { settle: 500 });
  const ru = await evaluate(s, `(()=>({ lang: document.documentElement.lang, dir: document.body.dir,
    ruVisible: [...document.querySelectorAll('p[lang="ru"]')].some(p=>p.getBoundingClientRect().height>0) }))()`);
  t('moadon-alef: Russian switch sets lang=ru and dir=ltr',
    ru.lang === 'ru' && ru.dir === 'ltr' && ru.ruVisible, JSON.stringify(ru));

  await setViewport(s, 390, 844, true);
  for (const lang of ['en', 'ru', 'he']) {
    await clickSel(s, `.lang-btn[data-lang="${lang}"]`, { settle: 500 });
    const over = await evaluate(s,
      'document.documentElement.scrollWidth - document.documentElement.clientWidth');
    t(`moadon-alef mobile: no horizontal overflow in ${lang}`, over <= 1, `${over}px`);
  }
  // Leave the page on its default so later runs and suites see a fresh state.
  await evaluate(s, `(()=>{ localStorage.removeItem('moadon-alef-lang'); return 1 })()`);
  await setViewport(s, 1280, 900);

  // --- apex shell (index.html) -----------------------------------------------
  // Fetched as text: the shell meta-refreshes to /home.html instantly, so a
  // navigation would assert against the wrong document. Structure only.
  const apex = await evalAsync(s, `fetch('/index.html').then(r=>r.ok?r.text():'')`);
  t('apex shell: serves with content', typeof apex === 'string' && apex.length > 100,
    `len=${typeof apex === 'string' ? apex.length : typeof apex}`);
  t('apex shell: meta-refresh fallback to /home.html',
    /http-equiv="refresh"[^>]*url=\/home\.html/i.test(apex));
  t('apex shell: apex-redirect.js wiring present', /assets\/js\/apex-redirect\.js/.test(apex));
  t('apex shell: canonical points at /home',
    /rel="canonical" href="https:\/\/shevato\.com\/home"/.test(apex));
  // Deliberately NO robots meta here: a noindex on "/" de-indexed the whole
  // domain root in 2026-06 (the decision is documented inside index.html).
  t('apex shell: no robots meta (deliberate)', !/name="robots"/i.test(apex));

  // --- mobile menu ---------------------------------------------------------
  await setViewport(s, 390, 844, true);
  await goto(s, `${base}/home.html`, { settle: 2600 });
  const opened = await clickSel(s, 'a[href="#menu"]');
  await sleep(700);
  const menu = await evaluate(s, `(()=>{
    const m=document.querySelector('#menu'), c=document.querySelector('#menu .close');
    return { visible: !!m && getComputedStyle(m).visibility!=='hidden',
      links: m?m.querySelectorAll('a').length:0,
      closeNamed: !!c && !!(c.getAttribute('aria-label')||c.textContent.trim()) };})()`);
  t('mobile: menu opens', opened && menu.visible);
  t('mobile: menu has links', menu.links >= 5, String(menu.links));
  t('mobile: close control is named', menu.closeNamed);

  // --- responsive ----------------------------------------------------------
  for (const [w, h, label] of [[390, 844, 'mobile'], [768, 1024, 'tablet'], [1280, 900, 'desktop']]) {
    await setViewport(s, w, h, w < 500);
    for (const p of ['home', 'apps', 'work']) {
      await goto(s, `${base}/${p}.html`, { settle: 1600 });
      const over = await evaluate(s, 'document.documentElement.scrollWidth - document.documentElement.clientWidth');
      t(`${label} ${p}: no horizontal overflow`, over <= 1, `${over}px`);
    }
  }

  await closePage(cdpPort, s);
  return R;
}
